import { chmodSync, existsSync, realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, extname, isAbsolute } from 'node:path'
import { join } from 'path/posix'
import { rollup, type OutputChunk, type OutputOptions, type Plugin, type PreRenderedChunk, type RollupError, type RollupOptions } from 'rollup'
import MagicString from 'magic-string'
import nodeResolve from '@rollup/plugin-node-resolve'
import json from '@rollup/plugin-json'
import commonjs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'
import esbuild, { minify, type Options as EsbuildOptions } from 'rollup-plugin-esbuild'

export interface BuildOptions {
  /// Source directory, default is `"./src"`.
  src?: string
  /// Distination directory, default is `"./dist"`.
  dist?: string
  /// Additional entry points from command line.
  _?: string[]
  /// Options passed to `rollup-plugin-dts`.
  dts?: import('rollup-plugin-dts').Options
  /// Options passed to `rollup-plugin-esbuild`.
  esbuild?: EsbuildOptions
  /// Enable the `minify` plugin from `rollup-plugin-esbuild`.
  minify?: boolean
  /// Enable sourcemap, default is `false`.
  sourcemap?: boolean | 'inline'
}

type PackageType = 'module' | 'commonjs'

interface EntryPoint {
  type: PackageType | 'types'
  from: string
  in: string
  out: string
  cli?: true
}

export const build = async (options: BuildOptions = {}) => {
  const on_error = (error: RollupError) => {
    process.removeListener('uncaughtException', on_error)
    console.error('' + error)
    if (error && error.frame) {
      console.error(error.frame)
    }
  }
  process.on('uncaughtException', on_error);

  const src = normalize(options.src || './src')
  const dist = normalize(options.dist || './dist')
  const config = await resolve_config(options, src, dist)

  for (const p in config.entries) {
    await rm(p, { force: true })
    await rm(p + '.map', { force: true })
  }

  const tasks: Promise<any>[] = []
  for (const get_config of [get_config_for_module, get_config_for_types]) {
    for (const conf of await get_config(config)) {
      tasks.push(rollup(conf).then(bundle => Promise.all(conf.output.map(option => bundle.write(option)))))
    }
  }

  await Promise.all(tasks)
}

type ResolvedConfig = Awaited<ReturnType<typeof resolve_config>>

const resolve_config = async (options: BuildOptions, src: string, dist: string) => {
  const extensions = {
    '.d.ts': ['.d.ts', '.d.mts', '.d.cts', '.ts', '.mts', '.cts'],
    '.d.mts': ['.d.mts', '.d.ts', '.d.cts', '.ts', '.mts', '.cts'],
    '.d.cts': ['.d.cts', '.d.ts', '.d.mts', '.ts', '.mts', '.cts'],
    '.js': ['.js', '.ts', '.tsx', '.mts', '.cts'],
    '.mjs': ['.mjs', '.js', '.cjs', '.mts', '.cts', '.ts'],
    '.cjs': ['.cjs', '.js', '.mjs', '.mts', '.cts', '.ts'],
  } as const;

  const get_source = (p: string) => {
    p = normalize(p)
    let temp = src + p.slice(dist.length)
    for (let ext in extensions) if (p.endsWith(ext)) {
      let source = try_extensions(temp.slice(0, -ext.length), extensions[ext])
      if (source) return source
    }
    throw new Error(`Not found source for "${p}"`)
  }

  const try_extensions = (base: string, extensions: readonly string[]) => {
    for (let ext of extensions) {
      let p = base + ext
      if (existsSync(p)) return p
    }
  }

  let entries: Record<string, EntryPoint> = Object.create(null)

  const add_entry = (entry: EntryPoint) => {
    entry.out = normalize(entry.out)
    let exist = entries[entry.out]
    if (exist) {
      Object.assign(exist, entry)
    } else {
      entries[entry.out] = entry
    }
  }

  let package_json = 'package.json'
  if (!existsSync(package_json)) {
    throw new Error('Not found "package.json" in ' + process.cwd())
  }

  let pkg = JSON.parse(await readFile(package_json, 'utf8'))
  let version: string = pkg.version || ''
  let package_type: PackageType = pkg.type === 'module' ? 'module' : 'commonjs'

  const get_type = (p: string): PackageType => {
    if (p.endsWith('.mjs')) return 'module'
    if (p.endsWith('.cjs')) return 'commonjs'
    return package_type
  }

  if (pkg.main) {
    add_entry({ type: get_type(pkg.main), from: 'main', in: get_source(pkg.main), out: pkg.main })
  }

  if (pkg.module) {
    add_entry({ type: 'module', from: 'module', in: get_source(pkg.module), out: pkg.module })
  }

  if (pkg.types) {
    add_entry({ type: 'types', from: 'types', in: get_source(pkg.types), out: pkg.types })
  }

  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      add_entry({ type: get_type(pkg.bin), from: 'bin', in: get_source(pkg.bin), out: pkg.bin, cli: true })
    } else for (let name in pkg.bin) {
      let value: string = pkg.bin[name]
      add_entry({ type: get_type(value), from: `bin.${name}`, in: get_source(value), out: value, cli: true })
    }
  }

  if (pkg.exports) for (let entry of parse_exports(pkg.exports, get_source, get_type)) {
    add_entry(entry)
  }

  let external: (string | RegExp)[] = []
  for (let k of ['peerDependencies', 'dependencies', 'optionalDependencies']) {
    if (pkg[k]) for (let name in pkg[k]) {
      external.push(name, new RegExp('^' + name + '/'))
    }
  }

  if (options._) for (let p of options._) {
    add_entry(get_output(p, src, dist, package_type))
  }

  return { options, src, dist, version, entries, external }
}

const normalize = (p: string, dir = false) => {
  if (!isAbsolute(p) && p[0] !== '/' && p[0] !== '.') {
    p = './' + p
  }
  if (dir && !p.endsWith('/')) {
    p += '/'
  }
  return p
}

const get_output = (p: string, src: string, dist: string, package_type: PackageType): EntryPoint => {
  let input = p = normalize(p)
  if (!p.startsWith(src)) {
    throw new Error('Entry points must be in ' + src + ', got ' + p)
  }
  p = dist + p.slice(src.length)
  if (p.endsWith('.mts')) {
    p = p.slice(0, -4) + '.mjs'
    return { type: 'module', from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.cts')) {
    p = p.slice(0, -4) + '.cjs'
    return { type: 'commonjs', from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.d.ts')) {
    return { type: 'types', from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.ts')) {
    p = p.slice(0, -3) + '.js'
    return { type: package_type, from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.mjs')) {
    return { type: 'module', from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.cjs')) {
    return { type: 'commonjs', from: 'manual', in: input, out: p }
  }
  if (p.endsWith('.js')) {
    return { type: package_type, from: 'manual', in: input, out: p }
  }
  throw new Error('Don\'t know how to build ' + input)
}

const parse_exports = (map: any, get_source: (p: string) => string, get_type: (p: string) => PackageType, from = 'exports'): EntryPoint[] => {
  if (map) {
    if (typeof map === 'string') {
      if (map[0] === '.') return [{ type: get_type(map), from, in: get_source(map), out: map }]
      return []
    }

    if (Array.isArray(map)) {
      return map.flatMap((map2, i) => (
        typeof map2 === 'string' ?
          map2[0] === '.' ?
            { type: get_type(map2), from: `${from}[${i}]`, in: get_source(map2), out: map2 }
          : []
        : parse_exports(map2, get_source, get_type, `${from}[${i}]`)
      ))
    }

    if (typeof map === 'object') {
      let entries: EntryPoint[] = []
      for (let key in map) {
        let value = map[key]
        if (typeof value === 'string') {
          entries.push({
            type: key === 'types' ? 'types' : get_type(value),
            from: `${from}.${key}`,
            in: get_source(value),
            out: value,
          })
        } else {
          entries.push(...parse_exports(value, get_source, get_type, `${from}.${key}`))
        }
      }
      return entries
    }
  }

  return []
}

type ResolvedRollupOptions = RollupOptions & { input: string[], output: OutputOptions[] }
type GetConfig = (config: ResolvedConfig) => Promise<ResolvedRollupOptions[]>

const get_config_for_module: GetConfig = async (config) => {
  const options = new Map<string, ResolvedRollupOptions>()

  for (let out in config.entries) {
    let entry = config.entries[out]
    if (entry.type !== 'types') {
      let key = `${entry.type}-${extname(out)}`
      let value: ResolvedRollupOptions

      if (options.has(key)) {
        value = options.get(key)!
      } else {
        value = {
          input: [],
          plugins: [
            external_node_builtins(config),
            resolve_typescript_js(config),
            nodeResolve({
              extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
            }),
            replace({
              preventAssignment: true,
              values: {
                __DEV__: 'process.env.NODE_ENV !== "production"',
                __VERSION__: JSON.stringify(config.version),
              }
            }),
            strip_hashbang(config),
            commonjs(),
            json({ preferConst: true }),
            esbuild(config.options.esbuild),
            config.options.minify && minify(config.options.esbuild),
            patch_binary(config),
          ],
          output: [{
            dir: config.dist,
            exports: 'auto',
            format: entry.type,
            chunkFileNames: `[name]-[hash]${extname(out)}`,
            sourcemap: config.options.sourcemap,
            entryFileNames(chunk) {
              let p = realpathSync.native(strip_query(chunk.facadeModuleId!))
              p = basename(p, extname(p))
              return p + extname(out)
            },
          }],
          external: config.external,
        }
        options.set(key, value)
      }

      if (!value.input.includes(entry.in)) {
        value.input.push(entry.in)
      }
    }
  }

  return [...options.values()]
}

const get_config_for_types: GetConfig = async (config) => {
  let input: string[] = [], output: OutputOptions[] = []

  for (let out in config.entries) {
    let entry = config.entries[out]
    if (entry.type === 'types') {
      if (!input.includes(entry.in)) input.push(entry.in)

      output.push({
        dir: config.dist,
        exports: 'auto',
        format: 'esm',
        entryFileNames(chunk) {
          let p = realpathSync.native(strip_query(chunk.facadeModuleId!))
          p = basename(p, extname(p))
          return p + get_dts_ext(entry.out)
        },
      })
    }
  }

  if (input.length === 0) return [];

  const { default: dts } = await import('rollup-plugin-dts')

  return [{
    input,
    plugins: [
      external_node_builtins(config),
      resolve_typescript_js(config),
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
      })
    ],
    output,
    external: config.external,
  }]
}

const get_dts_ext = (p: string) => {
  let index = p.lastIndexOf('.d.')
  if (index >= 0) {
    return p.slice(index)
  }
  return '.d.ts'
}

interface CustomPlugin {
  (config: ResolvedConfig): Plugin
}

const external_node_builtins: CustomPlugin = () => ({
  name: 'external-node-builtins',
  resolveId(id) {
    let has_node_protocol = id.startsWith('node:')
    if (has_node_protocol) {
      id = id.slice(5)
    }
    if (has_node_protocol || builtinModules.includes(id)) {
      return { id, external: true }
    }
  }
})

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

const strip_hashbang: CustomPlugin = (config) => ({
  name: 'strip-hashbang',
  transform(code) {
    if (code.startsWith('#!')) {
      let index = code.indexOf('\n')
      if (index < 0) {
        index = code.length - 1
      }
      let str = new MagicString(code).remove(0, index + 1)
      return {
        code: str.toString(),
        map: config.options.sourcemap ? str.generateMap({ hires: true }) : void 0
      }
    }
  }
})

const patch_binary: CustomPlugin = (config) => {
  const executables = new Set<string>()
  for (let out in config.entries) {
    let entry = config.entries[out]
    if (entry.cli) executables.add(out)
  }

  return {
    name: 'patch-binary',
    renderChunk(code, chunk, options) {
      if (!options.dir || !chunk.isEntry || !chunk.facadeModuleId || typeof options.entryFileNames !== 'function') return;

      if (executables.has(`./${join(options.dir, options.entryFileNames(chunk))}`)) {
        const str = new MagicString(code).prepend('#!/usr/bin/env node\n')
        return {
          code: str.toString(),
          map: options.sourcemap ? str.generateMap({ hires: true }) : void 0
        }
      }
    },
    writeBundle(options, bundle) {
      if (!options.dir || typeof options.entryFileNames !== 'function') return;

      for (let k in bundle) {
        let chunk = bundle[k] as OutputChunk
        if (chunk.isEntry && chunk.facadeModuleId) {
          chmodSync(`./${join(options.dir, options.entryFileNames(chunk))}`, 0o755)
        }
      }
    }
  }
}

const strip_query = (s: string) => {
  let i = s.indexOf('?')
  if (i >= 0) {
    s = s.slice(0, i)
  }
  return s
}
