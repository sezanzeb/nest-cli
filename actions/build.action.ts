import * as chalk from 'chalk';
import { join } from 'path';
import * as ts from 'typescript';
import { Input } from '../commands';
import { AssetsManager } from '../lib/compiler/assets-manager';
import { Compiler } from '../lib/compiler/compiler';
import { getBuilder } from '../lib/compiler/helpers/get-builder';
import { getTscConfigPath } from '../lib/compiler/helpers/get-tsc-config.path';
import { getValueOrDefault } from '../lib/compiler/helpers/get-value-or-default';
import { getWebpackConfigPath } from '../lib/compiler/helpers/get-webpack-config-path';
import { TsConfigProvider } from '../lib/compiler/helpers/tsconfig-provider';
import { PluginsLoader } from '../lib/compiler/plugins/plugins-loader';
import { SwcCompiler } from '../lib/compiler/swc/swc-compiler';
import { TypeScriptBinaryLoader } from '../lib/compiler/typescript-loader';
import { WatchCompiler } from '../lib/compiler/watch-compiler';
import { WebpackCompiler } from '../lib/compiler/webpack-compiler';
import { WorkspaceUtils } from '../lib/compiler/workspace-utils';
import {
  Configuration,
  ConfigurationLoader,
  NestConfigurationLoader,
} from '../lib/configuration';
import {
  defaultOutDir,
  defaultWebpackConfigFilename,
} from '../lib/configuration/defaults';
import { FileSystemReader } from '../lib/readers';
import { ERROR_PREFIX } from '../lib/ui';
import { AbstractAction } from './abstract.action';
import webpack = require('webpack');

export class BuildAction extends AbstractAction {
  protected readonly pluginsLoader = new PluginsLoader();
  protected readonly tsLoader = new TypeScriptBinaryLoader();
  protected readonly tsConfigProvider = new TsConfigProvider(this.tsLoader);
  protected readonly fileSystemReader = new FileSystemReader(process.cwd());
  protected readonly loader: ConfigurationLoader = new NestConfigurationLoader(
    this.fileSystemReader,
  );
  protected readonly assetsManager = new AssetsManager();
  protected readonly workspaceUtils = new WorkspaceUtils();

  public async handle(commandInputs: Input[], commandOptions: Input[]) {
    try {
      const watchModeOption = commandOptions.find(
        (option) => option.name === 'watch',
      );
      const watchMode = !!(watchModeOption && watchModeOption.value);

      const watchAssetsModeOption = commandOptions.find(
        (option) => option.name === 'watchAssets',
      );
      const watchAssetsMode = !!(
        watchAssetsModeOption && watchAssetsModeOption.value
      );

      await this.runBuild(
        commandInputs,
        commandOptions,
        watchMode,
        watchAssetsMode,
      );
    } catch (err) {
      if (err instanceof Error) {
        console.log(`\n${ERROR_PREFIX} ${err.message}\n`);
      } else {
        console.error(`\n${chalk.red(err)}\n`);
      }
      process.exit(1);
    }
  }

  public async runBuild(
    commandInputs: Input[],
    commandOptions: Input[],
    watchMode: boolean,
    watchAssetsMode: boolean,
    isDebugEnabled = false,
    onSuccess?: () => void,
  ) {
    const configFileName = commandOptions.find(
      (option) => option.name === 'config',
    )!.value as string;
    const configuration = await this.loader.load(configFileName);
    const appName = commandInputs.find((input) => input.name === 'app')!
      .value as string;

    const pathToTsconfig = getTscConfigPath(
      configuration,
      commandOptions,
      appName,
    );
    const { options: tsOptions } =
      this.tsConfigProvider.getByConfigFilename(pathToTsconfig);
    const outDir = tsOptions.outDir || defaultOutDir;

    const isWebpackEnabled = getValueOrDefault<boolean>(
      configuration,
      'compilerOptions.webpack',
      appName,
      'webpack',
      commandOptions,
    );
    const builder = isWebpackEnabled
      ? { type: 'webpack' }
      : getBuilder(configuration, commandOptions, appName);

    await this.workspaceUtils.deleteOutDirIfEnabled(
      configuration,
      appName,
      outDir,
    );
    this.assetsManager.copyAssets(
      configuration,
      appName,
      outDir,
      watchAssetsMode,
    );

    switch (builder.type) {
      case 'tsc':
        return this.runTsc(
          watchMode,
          commandOptions,
          configuration,
          pathToTsconfig,
          appName,
          onSuccess,
        );
      case 'webpack':
        return this.runWebpack(
          configuration,
          appName,
          commandOptions,
          pathToTsconfig,
          isDebugEnabled,
          watchMode,
          onSuccess,
        );
      case 'swc':
        return this.runSwc(
          configuration,
          appName,
          pathToTsconfig,
          watchMode,
          commandOptions,
          tsOptions,
          onSuccess,
        );
    }
  }

  private async runSwc(
    configuration: Required<Configuration>,
    appName: string,
    pathToTsconfig: string,
    watchMode: boolean,
    options: Input[],
    tsOptions: ts.CompilerOptions,
    onSuccess: (() => void) | undefined,
  ) {
    const swc = new SwcCompiler(this.pluginsLoader);
    await swc.run(
      configuration,
      pathToTsconfig,
      appName,
      {
        watch: watchMode,
        typeCheck: getValueOrDefault<boolean>(
          configuration,
          'compilerOptions.typeCheck',
          appName,
          'typeCheck',
          options,
        ),
        tsOptions,
        assetsManager: this.assetsManager,
      },
      onSuccess,
    );
  }

  private runWebpack(
    configuration: Required<Configuration>,
    appName: string,
    commandOptions: Input[],
    pathToTsconfig: string,
    debug: boolean,
    watchMode: boolean,
    onSuccess: (() => void) | undefined,
  ) {
    const webpackCompiler = new WebpackCompiler(this.pluginsLoader);

    const webpackPath =
      getWebpackConfigPath(configuration, commandOptions, appName) ??
      defaultWebpackConfigFilename;

    const webpackConfigFactoryOrConfig = this.getWebpackConfigFactoryByPath(
      webpackPath,
      defaultWebpackConfigFilename,
    );
    return webpackCompiler.run(
      configuration,
      pathToTsconfig,
      appName,
      {
        inputs: commandOptions,
        webpackConfigFactoryOrConfig,
        debug,
        watchMode,
        assetsManager: this.assetsManager,
      },
      onSuccess,
    );
  }

  private runTsc(
    watchMode: boolean,
    options: Input[],
    configuration: Required<Configuration>,
    pathToTsconfig: string,
    appName: string,
    onSuccess: (() => void) | undefined,
  ) {
    if (watchMode) {
      const watchCompiler = new WatchCompiler(
        this.pluginsLoader,
        this.tsConfigProvider,
        this.tsLoader,
      );
      const isPreserveWatchOutputEnabled = options.find(
        (option) =>
          option.name === 'preserveWatchOutput' && option.value === true,
      );
      watchCompiler.run(
        configuration,
        pathToTsconfig,
        appName,
        { preserveWatchOutput: !!isPreserveWatchOutputEnabled },
        onSuccess,
      );
    } else {
      const compiler = new Compiler(
        this.pluginsLoader,
        this.tsConfigProvider,
        this.tsLoader,
      );
      compiler.run(
        configuration,
        pathToTsconfig,
        appName,
        undefined,
        onSuccess,
      );
      this.assetsManager.closeWatchers();
    }
  }

  private getWebpackConfigFactoryByPath(
    webpackPath: string,
    defaultPath: string,
  ): (
    config: webpack.Configuration,
    webpackRef: typeof webpack,
  ) => webpack.Configuration {
    const pathToWebpackFile = join(process.cwd(), webpackPath);
    try {
      return require(pathToWebpackFile);
    } catch (err) {
      if (webpackPath !== defaultPath) {
        throw err;
      }
      return ({}) => ({});
    }
  }
}
