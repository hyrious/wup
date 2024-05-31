import sade from 'sade'
import { register } from 'node:module'

sade('@hyrious/wup')
   .version(__VERSION__)

   .command('build', 'Build the TypeScript library', { default: true })
   .option('--src', 'Source directory', './src')
   .option('--dist', 'Distination directory', './dist')
   .option('--minify', 'Enable minify', false)
   .option('--sourcemap', 'Enable sourcemap, can be \'inline\'')
   .action(async function patch_and_build(args) {
      if (__VERSION__) register('./register.js', import.meta.url)
      const { build } = await import('./index.js')
      return build(args)
   })

   .parse(process.argv)
