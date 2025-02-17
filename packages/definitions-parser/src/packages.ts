import assert = require("assert");
import { Author } from "@definitelytyped/header-parser";
import { FS, mapValues, assertSorted, unmangleScopedPackage, assertDefined, unique } from "@definitelytyped/utils";
import { AllTypeScriptVersion, TypeScriptVersion } from "@definitelytyped/typescript-versions";
import * as semver from "semver";
import { readDataFile } from "./data-file";
import { scopeName, typesDirectoryName } from "./lib/settings";
import { parseVersionFromDirectoryName } from "./lib/definition-parser";

export class AllPackages {
  static async read(dt: FS): Promise<AllPackages> {
    return AllPackages.from(await readTypesDataFile(), readNotNeededPackages(dt));
  }

  static from(data: TypesDataFile, notNeeded: readonly NotNeededPackage[]): AllPackages {
    return new AllPackages(
      mapValues(new Map(Object.entries(data)), (raw) => new TypingsVersions(raw)),
      notNeeded
    );
  }

  static async readTypings(): Promise<readonly TypingsData[]> {
    return AllPackages.from(await readTypesDataFile(), []).allTypings();
  }
  static async readLatestTypings(): Promise<readonly TypingsData[]> {
    return AllPackages.from(await readTypesDataFile(), []).allLatestTypings();
  }

  /** Use for `--single` tasks only. Do *not* call this in a loop! */
  static async readSingle(name: string): Promise<TypingsData> {
    const data = await readTypesDataFile();
    const raw = data[name];
    if (!raw) {
      throw new Error(`Can't find package ${name}`);
    }
    const versions = Object.values(raw);
    if (versions.length > 1) {
      throw new Error(`Package ${name} has multiple versions.`);
    }
    return new TypingsData(versions[0], /*isLatest*/ true);
  }

  static readSingleNotNeeded(name: string, dt: FS): NotNeededPackage {
    const notNeeded = readNotNeededPackages(dt);
    const pkg = notNeeded.find((p) => p.name === name);
    if (pkg === undefined) {
      throw new Error(`Cannot find not-needed package ${name}`);
    }
    return pkg;
  }

  private constructor(
    private readonly data: ReadonlyMap<string, TypingsVersions>,
    private readonly notNeeded: readonly NotNeededPackage[]
  ) {}

  getNotNeededPackage(name: string): NotNeededPackage | undefined {
    return this.notNeeded.find((p) => p.name === name);
  }

  hasTypingFor(dep: PackageId): boolean {
    return this.tryGetTypingsData(dep) !== undefined;
  }

  /**
   * Whether a package maintains multiple minor versions of typings simultaneously by
   * using minor-versioned directories like 'react-native/v14.1'
   */
  hasSeparateMinorVersions(name: string) {
    const versions = Array.from(assertDefined(this.data.get(getMangledNameForScopedPackage(name))).getAll());
    const minors = versions.map((v) => v.minor);
    return minors.length !== unique(minors).length;
  }

  tryResolve(dep: PackageId): PackageId {
    const versions = this.data.get(getMangledNameForScopedPackage(dep.name));
    return (versions && versions.tryGet(dep.version)?.id) || dep;
  }

  resolve(dep: PackageId): PackageIdWithDefiniteVersion {
    const versions = this.data.get(getMangledNameForScopedPackage(dep.name));
    if (!versions) {
      throw new Error(`No typings found with name '${dep.name}'.`);
    }
    return versions.get(dep.version).id;
  }

  /** Gets the latest version of a package. E.g. getLatest(node v6) was node v10 (before node v11 came out). */
  getLatest(pkg: TypingsData): TypingsData {
    return pkg.isLatest ? pkg : this.getLatestVersion(pkg.name);
  }

  private getLatestVersion(packageName: string): TypingsData {
    const latest = this.tryGetLatestVersion(packageName);
    if (!latest) {
      throw new Error(`No such package ${packageName}.`);
    }
    return latest;
  }

  tryGetLatestVersion(packageName: string): TypingsData | undefined {
    const versions = this.data.get(getMangledNameForScopedPackage(packageName));
    return versions && versions.getLatest();
  }

  getTypingsData(id: PackageId): TypingsData {
    const pkg = this.tryGetTypingsData(id);
    if (!pkg) {
      throw new Error(`No typings available for ${JSON.stringify(id)}`);
    }
    return pkg;
  }

  tryGetTypingsData({ name, version }: PackageId): TypingsData | undefined {
    const versions = this.data.get(getMangledNameForScopedPackage(name));
    return versions && versions.tryGet(version);
  }

  allPackages(): readonly AnyPackage[] {
    return [...this.allTypings(), ...this.allNotNeeded()];
  }

  /** Note: this includes older version directories (`foo/v0`) */
  allTypings(): readonly TypingsData[] {
    return assertSorted(Array.from(flattenData(this.data)), (t) => t.name);
  }

  allLatestTypings(): readonly TypingsData[] {
    return assertSorted(
      Array.from(this.data.values()).map((versions) => versions.getLatest()),
      (t) => t.name
    );
  }

  allNotNeeded(): readonly NotNeededPackage[] {
    return this.notNeeded;
  }

  /** Returns all of the dependences *that have typings*, ignoring others, and including test dependencies. */
  *allDependencyTypings(pkg: TypingsData): Iterable<TypingsData> {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      const versions = this.data.get(getMangledNameForScopedPackage(name));
      if (versions) {
        yield versions.get(
          version,
          pkg.pathMappings[name]
            ? `${pkg.name} references this version of ${name} in its path mappings in tsconfig.json. If you are deleting this version, update ${pkg.name}’s path mappings accordingly.\n`
            : undefined
        );
      }
    }

    for (const name of pkg.testDependencies) {
      const versions = this.data.get(getMangledNameForScopedPackage(name));
      if (versions) {
        const version = pkg.pathMappings[name];
        yield version ? versions.get(version) : versions.getLatest();
      }
    }
  }
}

// Same as the function in moduleNameResolver.ts in typescript
export function getMangledNameForScopedPackage(packageName: string): string {
  if (packageName.startsWith("@")) {
    const replaceSlash = packageName.replace("/", "__");
    if (replaceSlash !== packageName) {
      return replaceSlash.slice(1); // Take off the "@"
    }
  }
  return packageName;
}

export const typesDataFilename = "definitions.json";

function* flattenData(data: ReadonlyMap<string, TypingsVersions>): Iterable<TypingsData> {
  for (const versions of data.values()) {
    yield* versions.getAll();
  }
}

export type AnyPackage = NotNeededPackage | TypingsData;

interface BaseRaw {
  /**
   * The name of the library.
   *
   * A human readable version, e.g. it might be "Moment.js" even though `packageName` is "moment".
   */
  readonly libraryName: string;
}

/** Prefer to use `AnyPackage` instead of this. */
export abstract class PackageBase {
  static compare(a: PackageBase, b: PackageBase): number {
    return a.name.localeCompare(b.name);
  }

  /** Note: for "foo__bar" this is still "foo__bar", not "@foo/bar". */
  abstract readonly name: string;
  readonly libraryName: string;

  get unescapedName(): string {
    return unmangleScopedPackage(this.name) || this.name;
  }

  /** Short description for debug output. */
  get desc(): string {
    return this.isLatest ? this.name : `${this.name} v${this.major}.${this.minor}`;
  }

  constructor(data: BaseRaw) {
    this.libraryName = data.libraryName;
  }

  isNotNeeded(): this is NotNeededPackage {
    return this instanceof NotNeededPackage;
  }

  abstract readonly isLatest: boolean;
  abstract readonly declaredModules: readonly string[];
  abstract readonly globals: readonly string[];
  abstract readonly minTypeScriptVersion: TypeScriptVersion;

  /** '@types/foo' for a package 'foo'. */
  get fullNpmName(): string {
    return getFullNpmName(this.name);
  }

  abstract readonly major: number;
  abstract readonly minor: number;

  get id(): PackageIdWithDefiniteVersion {
    return { name: this.name, version: { major: this.major, minor: this.minor } };
  }
}

export function getFullNpmName(packageName: string): string {
  return `@${scopeName}/${getMangledNameForScopedPackage(packageName)}`;
}

interface NotNeededPackageRaw extends BaseRaw {
  /**
   * If this is available, @types typings are deprecated as of this version.
   * This is useful for packages that previously had DefinitelyTyped definitions but which now provide their own.
   */
  // This must be "major.minor.patch"
  readonly asOfVersion: string;
}

export class NotNeededPackage extends PackageBase {
  readonly version: semver.SemVer;

  get license(): License.MIT {
    return License.MIT;
  }

  static fromRaw(name: string, raw: NotNeededPackageRaw) {
    if (name !== name.toLowerCase()) {
      throw new Error(`not-needed package '${name}' must use all lower-case letters.`);
    }
    for (const key of Object.keys(raw)) {
      if (!["libraryName", "sourceRepoURL", "asOfVersion"].includes(key)) {
        throw new Error(`Unexpected key in not-needed package: ${key}`);
      }
    }
    if (raw.libraryName !== raw.libraryName.toLowerCase()) {
      throw new Error(`not-needed package '${name}' must use a libraryName that is all lower-case letters.`);
    }

    return new NotNeededPackage(name, raw.libraryName, raw.asOfVersion);
  }

  constructor(readonly name: string, readonly libraryName: string, asOfVersion: string) {
    super({ libraryName });
    assert(libraryName && name && asOfVersion);
    this.version = new semver.SemVer(asOfVersion);
  }

  get major(): number {
    return this.version.major;
  }
  get minor(): number {
    return this.version.minor;
  }

  // A not-needed package has no other versions. (that would be possible to allow but nobody has really needed it yet)
  get isLatest(): boolean {
    return true;
  }
  get declaredModules(): readonly string[] {
    return [];
  }
  get globals(): readonly string[] {
    return this.globals;
  }
  get minTypeScriptVersion(): TypeScriptVersion {
    return TypeScriptVersion.lowest;
  }

  deprecatedMessage(): string {
    return `This is a stub types definition. ${this.libraryName} provides its own type definitions, so you do not need this installed.`;
  }
}

export interface TypingsVersionsRaw {
  [version: `${number}.${number}`]: TypingsDataRaw;
}

/** Minor may be unknown if parsed from a major-only version directory, like 'types/v15' */
export interface DirectoryParsedTypingVersion {
  major: number;
  minor?: number;
}

/** Version parsed from DT header comment, so both major and minor are known */
export interface HeaderParsedTypingVersion {
  major: number;
  minor: number;
}

export function formatTypingVersion(version: DirectoryParsedTypingVersion) {
  return `${version.major}${version.minor === undefined ? "" : `.${version.minor}`}`;
}

/** If no version is specified, uses "*". */
export type DependencyVersion = DirectoryParsedTypingVersion | "*";

export function formatDependencyVersion(version: DependencyVersion) {
  return version === "*" ? "*" : formatTypingVersion(version);
}

export interface PackageJsonDependency {
  readonly name: string;
  readonly version: string;
}

export interface TypingsDataRaw extends BaseRaw {
  /**
   * The NPM name to publish this under, e.g. "jquery".
   *
   * This does not include "@types".
   */
  readonly typingsPackageName: string;

  /**
   * Other definitions, that exist in the same typings repo, that this package depends on.
   *
   * These will refer to *package names*, not *folder names*.
   */
  readonly dependencies: { readonly [name: string]: DependencyVersion };

  /**
   * Package `imports`, as read in the `package.json` file
   */
  readonly imports?: object;

  /**
   * Package `exports`, as read in the `package.json` file
   */
  readonly exports?: object | string;

  /**
   * Package `type`, as read in the `package.json` file
   */
  readonly type?: string;

  /**
   * Other definitions, that exist in the same typings repo, that the tests, but not the types, of this package depend on.
   *
   * These are always the latest version and will not include anything already in `dependencies`.
   */
  readonly testDependencies: readonly string[];

  /**
   * External packages, from outside the typings repo, that provide definitions that this package depends on.
   */
  readonly packageJsonDependencies: readonly PackageJsonDependency[];

  /**
   * Represents that there was a path mapping to a package.
   *
   * Not all path mappings are direct dependencies, they may be necessary for transitive dependencies. However, where `dependencies` and
   * `pathMappings` share a key, they *must* share the same value.
   */
  readonly pathMappings: { readonly [packageName: string]: DirectoryParsedTypingVersion };

  /**
   * List of people that have contributed to the definitions in this package.
   *
   * These people will be requested for issue/PR review in the https://github.com/DefinitelyTyped/DefinitelyTyped repo.
   */
  readonly contributors: readonly Author[];

  /**
   * The [older] version of the library that this definition package refers to, as represented *on-disk*.
   *
   * @note The latest version always exists in the root of the package tree and thus does not have a value for this property.
   */
  readonly libraryVersionDirectoryName?: string;

  /**
   * Major version of the library.
   *
   * This data is parsed from a header comment in the entry point `.d.ts` and will be `0` if the file did not specify a version.
   */
  readonly libraryMajorVersion: number;

  /**
   * Minor version of the library.
   *
   * This data is parsed from a header comment in the entry point `.d.ts` and will be `0` if the file did not specify a version.
   */
  readonly libraryMinorVersion: number;

  /**
   * Minimum required TypeScript version to consume the definitions from this package.
   */
  readonly minTsVersion: AllTypeScriptVersion;

  /**
   * List of TS versions that have their own directories, and corresponding "typesVersions" in package.json.
   * Usually empty.
   */
  readonly typesVersions: readonly TypeScriptVersion[];

  /**
   * Files that should be published with this definition, e.g. ["jquery.d.ts", "jquery-extras.d.ts"]
   *
   * Does *not* include a partial `package.json` because that will not be copied directly.
   */
  readonly files: readonly string[];

  /**
   * The license that this definition package is released under.
   *
   * Can be either MIT or Apache v2, defaults to MIT when not explicitly defined in this package’s "package.json".
   */
  readonly license: License;

  /**
   * A hash of the names and contents of the `files` list, used for versioning.
   */
  readonly contentHash: string;

  /**
   * Name or URL of the project, e.g. "http://cordova.apache.org".
   */
  readonly projectName: string;

  /**
   * A list of *values* declared in the global namespace.
   *
   * @note This does not include *types* declared in the global namespace.
   */
  readonly globals: readonly string[];

  /**
   * External modules declared by this package. Includes the containing folder name when applicable (e.g. proper module).
   */
  readonly declaredModules: readonly string[];
}

// Note that BSD is not supported -- for that, we'd have to choose a *particular* BSD license from the list at https://spdx.org/licenses/
export const enum License {
  MIT = "MIT",
  Apache20 = "Apache-2.0",
}
const allLicenses = [License.MIT, License.Apache20];
export function getLicenseFromPackageJson(packageJsonLicense: unknown): License {
  if (packageJsonLicense === undefined) {
    // tslint:disable-line strict-type-predicates (false positive)
    return License.MIT;
  }
  if (typeof packageJsonLicense === "string" && packageJsonLicense === "MIT") {
    throw new Error(`Specifying '"license": "MIT"' is redundant, this is the default.`);
  }
  if (allLicenses.includes(packageJsonLicense as License)) {
    return packageJsonLicense as License;
  }
  throw new Error(
    `'package.json' license is ${JSON.stringify(packageJsonLicense)}.\nExpected one of: ${JSON.stringify(allLicenses)}}`
  );
}

export class TypingsVersions {
  private readonly map: ReadonlyMap<semver.SemVer, TypingsData>;

  /**
   * Sorted from latest to oldest.
   */
  private readonly versions: semver.SemVer[];

  constructor(data: TypingsVersionsRaw) {
    /**
     * Sorted from latest to oldest so that we publish the current version first.
     * This is important because older versions repeatedly reset the "latest" tag to the current version.
     */
    this.versions = Object.keys(data).map((key) => new semver.SemVer(`${key}.0`));
    this.versions.sort(semver.rcompare);

    this.map = new Map(
      this.versions.map((version, i) => [version, new TypingsData(data[`${version.major}.${version.minor}`], !i)])
    );
  }

  getAll(): Iterable<TypingsData> {
    return this.map.values();
  }

  get(version: DependencyVersion, errorMessage?: string): TypingsData {
    return version === "*" ? this.getLatest() : this.getLatestMatch(version, errorMessage);
  }

  tryGet(version: DependencyVersion): TypingsData | undefined {
    return version === "*" ? this.getLatest() : this.tryGetLatestMatch(version);
  }

  getLatest(): TypingsData {
    return this.map.get(this.versions[0])!;
  }

  private getLatestMatch(version: DirectoryParsedTypingVersion, errorMessage?: string): TypingsData {
    const data = this.tryGetLatestMatch(version);
    if (!data) {
      throw new Error(`Could not find version ${version.major}.${version.minor ?? "*"}. ${errorMessage || ""}`);
    }
    return data;
  }

  private tryGetLatestMatch(version: DirectoryParsedTypingVersion): TypingsData | undefined {
    const found = this.versions.find(
      (v) => v.major === version.major && (version.minor === undefined || v.minor === version.minor)
    );
    return found && this.map.get(found);
  }
}

export class TypingsData extends PackageBase {
  constructor(private readonly data: TypingsDataRaw, readonly isLatest: boolean) {
    super(data);
  }

  get name() {
    return this.data.typingsPackageName;
  }

  get testDependencies(): readonly string[] {
    return this.data.testDependencies;
  }
  get contributors(): readonly Author[] {
    return this.data.contributors;
  }
  get major(): number {
    return this.data.libraryMajorVersion;
  }
  get minor(): number {
    return this.data.libraryMinorVersion;
  }

  get minTypeScriptVersion(): TypeScriptVersion {
    return TypeScriptVersion.isSupported(this.data.minTsVersion) ? this.data.minTsVersion : TypeScriptVersion.lowest;
  }
  get typesVersions(): readonly TypeScriptVersion[] {
    return this.data.typesVersions;
  }

  get files(): readonly string[] {
    return this.data.files;
  }
  get dtsFiles(): readonly string[] {
    return this.data.files.filter((f) => f.endsWith(".d.ts") || f.endsWith(".d.mts") || f.endsWith(".d.cts"));
  }
  get license(): License {
    return this.data.license;
  }
  get packageJsonDependencies(): readonly PackageJsonDependency[] {
    return this.data.packageJsonDependencies;
  }
  get contentHash(): string {
    return this.data.contentHash;
  }
  get declaredModules(): readonly string[] {
    return this.data.declaredModules;
  }
  get projectName(): string {
    return this.data.projectName;
  }
  get globals(): readonly string[] {
    return this.data.globals;
  }
  get pathMappings(): { readonly [packageName: string]: DirectoryParsedTypingVersion } {
    return this.data.pathMappings;
  }

  get dependencies(): { readonly [name: string]: DependencyVersion } {
    return this.data.dependencies;
  }

  get type() {
    return this.data.type;
  }

  get imports() {
    return this.data.imports;
  }

  get exports() {
    return this.data.exports;
  }

  get versionDirectoryName() {
    return this.data.libraryVersionDirectoryName && `v${this.data.libraryVersionDirectoryName}`;
  }

  /** Path to this package, *relative* to the DefinitelyTyped directory. */
  get subDirectoryPath(): string {
    return this.isLatest ? this.name : `${this.name}/${this.versionDirectoryName}`;
  }
}

/** Uniquely identifies a package. */
export interface PackageId {
  readonly name: string;
  readonly version: DependencyVersion;
}

export interface PackageIdWithDefiniteVersion {
  readonly name: string;
  readonly version: HeaderParsedTypingVersion;
}

export interface TypesDataFile {
  readonly [packageName: string]: TypingsVersionsRaw;
}
function readTypesDataFile(): Promise<TypesDataFile> {
  return readDataFile("parse-definitions", typesDataFilename) as Promise<TypesDataFile>;
}

export function readNotNeededPackages(dt: FS): readonly NotNeededPackage[] {
  const rawJson = dt.readJson("notNeededPackages.json"); // tslint:disable-line await-promise (tslint bug)
  return Object.entries((rawJson as { readonly packages: readonly NotNeededPackageRaw[] }).packages).map((entry) =>
    NotNeededPackage.fromRaw(...entry)
  );
}

/**
 * For "types/a/b/c", returns { name: "a", version: "*" }.
 * For "types/a/v3/c", returns { name: "a", version: 3 }.
 * For "x", returns undefined.
 */
export function getDependencyFromFile(file: string): PackageId | undefined {
  const parts = file.split("/");
  if (parts.length <= 2) {
    // It's not in a typings directory at all.
    return undefined;
  }

  const [typesDirName, name, subDirName] = parts; // Ignore any other parts

  if (typesDirName !== typesDirectoryName) {
    return undefined;
  }

  if (subDirName) {
    const version = parseVersionFromDirectoryName(subDirName);
    if (version !== undefined) {
      return { name, version };
    }
  }

  return { name, version: "*" };
}
