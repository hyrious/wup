import { readFile } from 'node:fs/promises'

interface LoadContext {
  conditions: string[]
  format?: string | null
  importAssertions: Record<string, string>
}

interface LoadFn {
  (specifier: string, context: LoadContext): Promise<LoadResult>
}

interface LoadResult {
  format: 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm'
  shortCircuit?: boolean
  source: string | ArrayBuffer | Uint8Array
  responseURL?: string
}

export async function load(url: string, context: LoadContext, nextLoad: LoadFn): Promise<LoadResult> {
  const result = await nextLoad(url, context)
  if (result.format === 'commonjs') {
    result.source ??= await readFile(new URL(result.responseURL ?? url), 'utf8')
  }

  if (result.format === 'commonjs' || result.format === 'module') {
    result.source = patch(url, result.source as string)
  }

  return result
}

function decode(source: string | ArrayBuffer | Uint8Array): string {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) source = new TextDecoder().decode(source)
  return source
}

function patch(url: string, source: string | ArrayBuffer | Uint8Array): string | ArrayBuffer | Uint8Array {
  if (/node_modules[\\/]rollup-plugin-dts/.test(url)) {
    source = decode(source)
    source = source.replaceAll('ts.createCompilerHost(', 'createCompilerHost(')
    source += `
/** --- patched by @hyrious/wup --- */
function createCompilerHost(compilerOptions, setParentNodes = false) {
  const host = ts.createCompilerHost(compilerOptions, setParentNodes);
  host.readFile = readAndMangleComments;
  return host;
}
function readAndMangleComments(name) {
  let file = ts.sys.readFile(name);
  if (file && !name.includes('node_modules'))
    file = file.replace(/(?<=^|\\n)(?:([ \\t]*)\\/\\/\\/.*\\n)+/g, (comment, space) => {
      if (comment.indexOf("\\n") + 1 === comment.length) {
        return \`\${space}/** \${comment.slice(space.length).replace(/\\/\\/\\/ ?/g, "").trimEnd()} */\\n\`;
      }
      return \`\${space}/**\\n\${space}\${comment.slice(space.length).replace(/\\/\\/\\/ ?/g, " * ")}\${space} */\\n\`;
    });
  return file;
}
`
  }

  else if (/node_modules[\\/]typescript/.test(url)) {
    source = decode(source)
    source = source.replace('indentStrings = ["", "    "];', 'indentStrings = ["", "  "];')
  }

  return source
}
