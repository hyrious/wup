import sade from 'sade'
import { register } from 'node:module'

const wup = sade('@hyrious/wup')

wup.version(__VERSION__)
   .option('-c, --config', 'Path to custom config', 'wup.config.js')
   .example('')

wup.command('build', 'Build the TypeScript library', { default: true })
   .action(async function patch_and_build(args) {
      if (__VERSION__) register('./register.js', import.meta.url)
      const { build } = await import('./index.js')
      return build(args)
   })

wup.parse(process.argv)
