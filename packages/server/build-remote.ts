import { readFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import { validateRemoteServerBundle } from "./buildRemoteValidation.js";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const { version } = JSON.parse(readFileSync("../../package.json", "utf-8"));
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

/**
 * remote bundle 的构建 target。stdio 供桌面远端 SSH 部署使用（deploy.ts 只消费
 * zcode-server.cjs）；http 供 headless Web 发布包使用（zcode-web-server.cjs，
 * 由 scripts/pack-web-release.mjs 组装进 tar.gz）。两者共用同一套插件、define
 * 与校验链，仅入口和产物名不同。
 */
type RemoteEntryTarget = "stdio" | "http";

const REMOTE_ENTRY_TARGETS: Record<
  RemoteEntryTarget,
  { entry: string; outfile: string; label: string }
> = {
  stdio: {
    entry: "src/entry-stdio.ts",
    outfile: "dist/remote/zcode-server.cjs",
    label: "stdio",
  },
  http: {
    entry: "src/entry-http.ts",
    outfile: "dist/remote/zcode-web-server.cjs",
    label: "web http",
  },
};

function parseTargetArg(): RemoteEntryTarget {
  const arg = process.argv[2];
  if (arg === undefined) {
    return "stdio";
  }
  if (!(arg in REMOTE_ENTRY_TARGETS)) {
    throw new Error(
      `Unknown remote entry target "${arg}". Expected one of: ${Object.keys(REMOTE_ENTRY_TARGETS).join(", ")}.`,
    );
  }
  return arg as RemoteEntryTarget;
}

/**
 * Let esbuild bundle node-pty's JS code normally, but keep .node native
 * addon files as external requires. node-pty's loadNativeModule() searches
 * for `./build/Release/pty.node` relative to itself, which matches our
 * deploy layout on the remote.
 *
 * CJS 格式而非 ESM：node-pty 内部大量使用 __dirname，ESM 里没有这个变量，
 * 用 CJS 输出可以直接原生支持，不需要任何 polyfill。
 */
const nativeAddonPlugin: Plugin = {
  name: "native-addon",
  setup(build) {
    // Mark all .node files as external — they can't be bundled
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const target = parseTargetArg();
const targetConfig = REMOTE_ENTRY_TARGETS[target];

const buildResult = await build({
  entryPoints: [targetConfig.entry],
  bundle: true,
  outfile: targetConfig.outfile,
  platform: "node",
  format: "cjs",
  target: "node22",
  plugins: [nativeAddonPlugin],
  // CJS 环境没有 import.meta.url，通过 banner 注入等价变量，
  // 再用 define 全局替换，这样源码无需关心最终打包格式。
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify(version),
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
  },
  metafile: true,
});

const remoteBundleSource = readFileSync(targetConfig.outfile, "utf-8");
const bundledInputs = Object.keys(buildResult.metafile.inputs);
validateRemoteServerBundle({ bundledInputs, source: remoteBundleSource });
// 修复：remote 单文件 bundle 内联第三方代码，dist/remote 也必须附完整声明。
await stageThirdPartyNotices("dist/remote");

console.log(`Built ${targetConfig.outfile} (${targetConfig.label} entry)`);
