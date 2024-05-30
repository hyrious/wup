# @hyrious/wup

Build TypeScript libraries.

Assumes your projects are set up like this:

- ESM only, your package.json has `"type": "module"`.
- TypeScript sources in an `src` directroy, will be compiled to `dist`.
- Doc comments with leading `///` syntax will be converted to `/**` JSDoc comments.

Requires Node.js &ge; 20.8.0 to use `module.register()` to patch dependencies at runtime.

> [!WARNING]
> Currently experimental. To test it locally, run
> ```sh
> npm run test:install
> # To uninstall,
> npm r -g @hyrious/wup
> ```

## Usage

```sh
mkdir awesome-library && cd awesome-library
npm create @hyrious -- --cli --public
npx @hyrious/license mit
npm install
npx @hyrious/wup
```

## Credits

- [@marijnh/buildtool](https://github.com/marijnh/buildtool)
- [pkgroll](https://github.com/privatenumber/pkgroll)
- [eslint-ts-patch](https://github.com/antfu/eslint-ts-patch) for the way to [patch](https://github.com/antfu/eslint-ts-patch/blob/main/lib/register.js) a library at runtime.

## License

MIT @ [hyrious](https://github.com/hyrious)
