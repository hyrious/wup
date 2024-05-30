import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import escalade from 'escalade'
import { chmodSync, existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { isAbsolute } from 'node:path'
import { join, relative } from 'path/posix'
import { rollup, type OutputChunk, type OutputOptions, type Plugin, type RollupOptions } from 'rollup'
import dts from 'rollup-plugin-dts'
import esbuild, { type Options as EsbuildOptions } from 'rollup-plugin-esbuild'

export interface BuildOptions {
  /// Additional entry points.
  _?: string[]
  /// Path to the config file.
  config?: string
  /// Options passed to `rollup-plugin-esbuild`.
  esbuild?: EsbuildOptions
}

export const build = async (options: BuildOptions) => {
  let config = await resolve_config(options)

  await rm('./dist', { recursive: true, force: true })

  let { entry_points } = config

  let rollup_module: RollupOptions | undefined
  let rollup_types: RollupOptions | undefined
  for (let k in entry_points) {
    let entry = entry_points[k]
    let rollup_options: RollupOptions
    if (entry.type == 'module') {
      rollup_options = rollup_module ||= get_config_for_module(options, config)
    } else {
      rollup_options = rollup_types ||= get_config_for_types(options, config);
    }
    let input = get_source(entry)
    if (!(rollup_options.input as string[]).includes(input)) {
      (rollup_options.input as string[]).push(input)
    }
  }
  if (rollup_module) (rollup_module.output as OutputOptions[]).push({
    dir: './dist',
    exports: 'auto',
    format: 'esm',
    chunkFileNames: `[name]-[hash].js`,
    entryFileNames(chunk) {
      let p = normalize_path(relative(process.cwd(), chunk.facadeModuleId!))
      return p.slice('./src/'.length, -'.ts'.length) + '.js'
    }
  })
  if (rollup_types) (rollup_types.output as OutputOptions[]).push({
    dir: './dist',
    entryFileNames(chunk) {
      let p = normalize_path(relative(process.cwd(), chunk.facadeModuleId!))
      return p.slice('./src/'.length, -'.ts'.length) + '.d.ts'
    },
    exports: 'auto',
    format: 'esm',
  })

  if (rollup_module) {
    let bundle = await rollup(rollup_module)
    for (let output_option of rollup_module.output as OutputOptions[]) {
      await bundle.write(output_option)
    }
  }

  if (rollup_types) {
    let bundle = await rollup(rollup_types)
    for (let output_option of rollup_types.output as OutputOptions[]) {
      await bundle.write(output_option)
    }
  }
}

interface EntryPoint {
  type: 'module' | 'types'
  from: 'main' | 'module' | 'types' | 'bin' | `bin.${string}` | 'exports' | `exports[${number}]` | `exports.${string}` | 'manual'
  out: string
  platform?: 'node'
  cli?: true
}

type ResolvedConfig = Awaited<ReturnType<typeof resolve_config>>

const resolve_config = async (options: BuildOptions) => {
  let version = ''
  let entry_points: Record<string, EntryPoint> = Object.create(null)
  const add_entry = (entry: EntryPoint) => {
    entry.out = normalize_path(entry.out)
    let exist = entry_points[entry.out]
    if (exist) {
      Object.assign(exist, entry)
    } else {
      entry_points[entry.out] = entry
    }
  }
  let external: (string | RegExp)[] = []

  let package_json = 'package.json'
  let package_json_path = await escalade(process.cwd(), (_, files) => {
    if (files.includes(package_json)) return package_json
  })
  if (package_json_path) {
    let pkg = JSON.parse(await readFile(package_json_path, 'utf8'))
    if (pkg.type !== 'module') {
      throw new Error('"package.json > type" must be "module"')
    }

    version = pkg.version

    if (pkg.main) {
      add_entry({ type: 'module', from: 'main', out: pkg.main })
    }

    if (pkg.module) {
      add_entry({ type: 'module', from: 'module', out: pkg.module })
    }

    if (pkg.types) {
      add_entry({ type: 'types', from: 'types', out: pkg.types })
    }

    if (pkg.bin) {
      if (typeof pkg.bin === 'string') {
        add_entry({ type: 'module', from: 'bin', out: pkg.bin, cli: true })
      } else for (let name in pkg.bin) {
        add_entry({ type: 'module', from: `bin.${name}`, out: pkg.bin[name], cli: true })
      }
    }

    if (pkg.exports) for (let entry of parse_exports(pkg.exports)) {
      add_entry(entry)
    }

    for (let k of ['peerDependencies', 'dependencies', 'optionalDependencies']) {
      if (pkg[k]) for (let name in pkg[k]) {
        external.push(name, new RegExp('^' + name + '/'))
      }
    }
  }

  if (options._) for (let p of options._) {
    add_entry(get_output(p))
  }

  return { version, entry_points, external }
}

const normalize_path = (p: string, dir?: boolean): string => {
  if (!isAbsolute(p) && !p.startsWith('/') && !p.startsWith('.')) {
    p = './' + p
  }
  if (dir && !p.endsWith('/')) {
    p += '/'
  }
  return p
}

const parse_exports = (map: any, from: EntryPoint['from'] = 'exports'): EntryPoint[] => {
  if (map) {
    if (typeof map === 'string') {
      if (map.startsWith('.')) return [{ type: 'module', from, out: map }]
      return []
    }

    if (Array.isArray(map)) {
      return map.flatMap((map2, i) => (
        typeof map2 === 'string' ?
          map2.startsWith('.') ?
            { type: 'module', from: `${from}[${i}]` as EntryPoint['from'], out: map2 }
          : []
        : parse_exports(map2, `${from}[${i}]` as EntryPoint['from'])
      ))
    }

    if (typeof map === 'object') {
      let entries: EntryPoint[] = []
      for (let key in map) {
        let value = map[key]
        if (typeof value === 'string') {
          entries.push({
            type: key === 'types' ? 'types' : 'module',
            from: `${from}.${key}` as EntryPoint['from'],
            out: value,
            platform: key === 'node' ? key : void 0
          })
        } else {
          entries.push(...parse_exports(value, `${from}.${key}` as EntryPoint['from']))
        }
      }
      return entries
    }
  }

  return []
}

const extensions = {
  '.js': ['.js', '.ts', '.tsx', '.mts', '.cts'],
  '.d.ts': ['.d.ts', '.d.mts', '.d.cts', '.ts', '.mts', '.cts'],
} as const

const get_source = (entry: EntryPoint, src = './src', dist = './dist'): string => {
  if (entry.out.endsWith('.js')) {
    let p = try_extensions(src + entry.out.slice(dist.length, -3), extensions['.js'])
    if (p) return p
  }

  if (entry.out.endsWith('.d.ts')) {
    let p = try_extensions(src + entry.out.slice(dist.length, -5), extensions['.d.ts'])
    if (p) return p
  }

  throw new Error(`Not found source for "${entry.out}"`)
}

const get_output = (p: string, src = './src', dist = './dist'): EntryPoint => {
  p = normalize_path(p)
  if (!p.startsWith(src)) {
    throw new Error('Entry points must be in ' + src)
  }
  p = dist + p.slice(src.length)
  if (p.endsWith('.ts')) p = p.slice(0, -3) + '.js'
  return { type: 'module', from: 'manual', out: p }
}

const try_extensions = (base: string, extensions: readonly string[]) => {
  for (let ext of extensions) {
    let p = base + ext
    if (existsSync(p)) return p
  }
}

interface GetConfig {
  (options: BuildOptions, config: ResolvedConfig): RollupOptions
}

const get_config_for_module: GetConfig = (options, config) => {
  return {
    input: [],
    plugins: [
      externalize_node_builtins(options, config),
      resolve_typescript_js(options, config),
      nodeResolve({
        extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
      }),
      replace({
        preventAssignment: true,
        values: {
          __VERSION__: JSON.stringify(config.version),
        }
      }),
      strip_hashbang(options, config),
      commonjs(),
      json({ preferConst: true }),
      esbuild(options.esbuild),
      patch_binary(options, config),
    ],
    output: [],
    external: config.external,
  }
}

const get_config_for_types: GetConfig = (options, config) => {
  return {
    input: [],
    plugins: [
      externalize_node_builtins(options, config),
      resolve_typescript_js(options, config),
      dts({
        respectExternal: true,
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          noEmitOnError: true,
          allowJs: true,
          checkJs: false,
          declarationMap: false,
          skipLibCheck: true,
          stripInternal: true,
          preserveSymlinks: false,
        }
      }),
    ],
    output: [],
    external: config.external,
  }
}

interface CustomPlugin {
  (options: BuildOptions, config: ResolvedConfig): Plugin
}

const externalize_node_builtins: CustomPlugin = () => {
  return {
    name: 'externalize-node-builtins',
    resolveId(id) {
      let has_node_protocol = id.startsWith('node:')
      if (has_node_protocol) {
        id = id.slice(5)
      }
      if (has_node_protocol || builtinModules.includes(id)) {
        return { id, external: true }
      }
    }
  }
}

const resolve_typescript_js: CustomPlugin = () => {
  const js_re = /\.(?:[mc]?js|jsx)$/

  return {
    name: 'resolve-typescript-js',
    resolveId(id, importer, options) {
      if (js_re.test(id) && importer) {
        return this.resolve(id.replace(/js(x?)$/, 'ts$1'))
      }
    }
  }
}

const strip_hashbang: CustomPlugin = () => {
  return {
    name: 'strip-hashbang',
    transform(code) {
      if (code.startsWith('#!')) {
        let index = code.indexOf('\n')
        if (index < 0) {
          index = code.length - 1
        }
        return code.slice(index + 1)
      }
    }
  }
}

const patch_binary: CustomPlugin = (options, config) => {
  const executables = new Set<string>()
  for (let k in config.entry_points) {
    let entry = config.entry_points[k]
    if (entry.cli) executables.add(entry.out)
  }

  return {
    name: 'patch-binary',
    renderChunk(code, chunk, outputOptions) {
      if (!chunk.isEntry || !chunk.facadeModuleId) return;

      const entryFileNames = outputOptions.entryFileNames as Exclude<typeof outputOptions.entryFileNames, string>
      const outputPath = `./${join(outputOptions.dir!, entryFileNames(chunk))}`

      if (executables.has(outputPath)) {
        return '#!/usr/bin/env node\n' + code
      }
    },
    writeBundle(outputOptions, bundle) {
      const entryFileNames = outputOptions.entryFileNames as Exclude<typeof outputOptions.entryFileNames, string>

      for (let k in bundle) {
        let chunk = bundle[k] as OutputChunk
        if (chunk.isEntry && chunk.facadeModuleId) {
          const outputPath = `./${join(outputOptions.dir!, entryFileNames(chunk))}`
          chmodSync(outputPath, 0o755)
        }
      }
    }
  }
}
