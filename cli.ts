#!/usr/bin/env -S npx ts-node

import minimist from 'minimist'
import { parse, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { generateAll, generateMagicNumbers, Writer } from './generator'
import { readFile } from 'fs/promises'
import pkg from './package.json'
import { XmlDataSource, Input } from './generator/datasource'
import { makeClassName } from './generator/code-utils'

type FileContext = {
  filename: string
  moduleName: string
  source: string
  input: Input
}

const MAVLINK_TYPES = new Set([
  'char',
  'uint8_t',
  'int8_t',
  'uint16_t',
  'int16_t',
  'uint32_t',
  'int32_t',
  'uint8_t_mavlink_version',
  'float',
  'int64_t',
  'uint64_t',
  'double',
])

const DEFAULT_ENUM_MODULES = new Map<string, string>([
  ['MavAutopilot', 'minimal'],
  ['MavModeFlag', 'minimal'],
  ['MavType', 'minimal'],
  ['MavBool', 'standard'],
  ['MavProtocolCapability', 'standard'],
  ['LandingTargetType', 'common'],
])

const args = minimist(process.argv.slice(2), {
  boolean: [
    'help',
    'version',
    'write',
    'magic',
  ],
  alias: {
    'help': 'h',
    'version': 'V',
    'write': 'w',
    'magic': 'm',
  },
  default: {
    help: false,
    version: false,
    write: false,
    magic: false,
  },
  unknown(name: string) {
    if (name.startsWith('-')) {
      console.error('ERROR: unknown parameter:', name)
      process.exit(2)
    }

    return true
  }
})

function print(msg: string) {
  process.stderr.write(msg)
}

function getModuleName(filename: string) {
  return parse(filename).name
}

function getOutputFileName(filename: string) {
  return filename.substring(0, filename.length - 3) + 'ts'
}

function getImportsTemplateFileName(filename: string) {
  return filename.substring(0, filename.length - 3) + 'imports.ts'
}

function getMagicNumbersFileName(filename: string) {
  return dirname(filename) + '/magic-numbers.ts'
}

async function generateFile(filename: string, moduleName: string) {
  print(`Generating ${filename}...`)

  const lines: string[] = []
  const source = (await readFile(filename)).toString()
  const output = { write: msg => lines.push(msg ?? '') } as Writer
  const { enums, commands, messages } = await generateAll(source, output, moduleName)

  print('done\n')

  return { code: lines.join('\n'), enums, commands, messages }
}

async function loadFileContexts(filenames: string[]) {
  const datasource = new XmlDataSource()

  return Promise.all(filenames.map(async filename => {
    const moduleName = getModuleName(filename)
    const source = (await readFile(filename)).toString()
    const input = await datasource.parse(source)

    return {
      filename,
      moduleName,
      source,
      input,
    } as FileContext
  }))
}

function getEnumModuleMap(contexts: FileContext[]) {
  const result = new Map(DEFAULT_ENUM_MODULES)

  contexts.forEach(context => {
    context.input.enumDefs?.forEach(entry => {
      if (!result.has(entry.name)) {
        result.set(entry.name, context.moduleName)
      }
    })
  })

  return result
}

function getImportedType(type: string) {
  if (type.endsWith('[]')) {
    return type.substring(0, type.length - 2)
  }

  return type
}

function generateImports(context: FileContext, enumModuleMap: Map<string, string>) {
  const importGroups = new Map<string, Set<string>>()
  const messages = context.input.messageDefs

  const addImport = (moduleName: string, symbol: string) => {
    if (!importGroups.has(moduleName)) {
      importGroups.set(moduleName, new Set())
    }

    importGroups.get(moduleName)?.add(symbol)
  }

  addImport('./mavlink', 'MavLinkData')
  addImport('./mavlink', 'MavLinkPacketRegistry')
  addImport('./mavlink', 'MavLinkPacketField')

  if ((context.input.commandTypeDefs?.length || 0) > 0) {
    addImport('./mavlink', 'MavLinkCommandRegistry')
  }

  messages.forEach(message => {
    message.fields.forEach(field => {
      const importedType = getImportedType(field.type)

      if (field.source.enum) {
        const enumName = makeClassName(field.source.enum)
        const enumModule = enumModuleMap.get(enumName)

        if (enumModule !== undefined && enumModule !== context.moduleName) {
          addImport(`./${enumModule}`, enumName)
        }
      } else if (MAVLINK_TYPES.has(importedType)) {
        addImport('./types', importedType)
      }
    })
  })

  return Array
    .from(importGroups.entries())
    .sort(([left], [right]) => {
      const rank = (moduleName: string) => {
        if (moduleName === './mavlink') return 0
        if (moduleName === './types') return 1
        return 2
      }

      return rank(left) - rank(right) || left.localeCompare(right)
    })
    .map(([moduleName, symbols]) => {
      const imports = Array.from(symbols).sort((left, right) => left.localeCompare(right))
      return `import { ${imports.join(', ')} } from "${moduleName}";`
    })
    .join('\n')
}

async function generateFiles(filenames: string[], write: boolean, magic: boolean) {
  const magicNumbers: Record<string, number> = {}
  const fileContexts = await loadFileContexts(filenames)
  const enumModuleMap = getEnumModuleMap(fileContexts)

  function updateMagicNumbersWithNewMessages(messages: { id: string, magic?: number }[]) {
    messages.forEach(message => {
      if (message.magic !== undefined) {
        magicNumbers[message.id] = message.magic
      }
    })
  }

  for (const filename of filenames) {
    const moduleName = getModuleName(filename)
    const context = fileContexts.find(entry => entry.filename === filename)

    if (context === undefined) {
      throw new Error(`Missing file context for ${filename}`)
    }

    const { code, messages } = await generateFile(filename, moduleName)
    updateMagicNumbersWithNewMessages(messages)

    if (write) {
      const outputFileName = getOutputFileName(filename)

      const autoImports = generateImports(context, enumModuleMap)
      const importBlock = [autoImports].filter(Boolean).join('\n')
      const output = importBlock ? `${importBlock}\n${code}` : code

      writeFileSync(outputFileName, output)
    } else {
      const autoImports = generateImports(context, enumModuleMap)
      const importBlock = [autoImports].filter(Boolean).join('\n')
      const output = importBlock ? `${importBlock}\n${code}` : code

      console.log(output)
    }
  }

  if (magic) {
    const magicNumbersFileName = getMagicNumbersFileName(filenames[0])
    print('Generating magic-numbers.ts...')
    writeFileSync(magicNumbersFileName, generateMagicNumbers(magicNumbers))
    print('done\n')
  }
}

if (args.version) {
  console.log(pkg.version)
  process.exit(0)
}

if (args.help) {
  console.log(`mavlink-mapping-gen v${pkg.version} by ${pkg.author}`)
  console.log('usage:')
  console.log(`  ${pkg.name} [options] def1.xml def2.xml ... \n`)
  console.log(`options:`)
  console.log(`  -V, --version                              # show program version and exit`)
  console.log(`  -h, --help                                 # show help and exit`)
  console.log(`  -w, --write                                # write the content to file rather than to standard output`)
  console.log(`  -m, --magic                                # generate magic-numbers.ts (implies -w)`)
  process.exit(0)
}

if (args._.length === 0) {
  console.error('ERROR: no input specified')
  process.exit(1)
}

generateFiles(args._, args.write || args._.length > 1 || args.magic, args.magic)
