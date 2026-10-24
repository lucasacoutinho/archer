# Changelog

## 0.2.1 - 2026-10-24

### Fixed

- Moved `typescript` from `peerDependencies` to `dependencies` (`^5.9.0`).
  Archer uses the TypeScript compiler API to parse imports, and TypeScript 7
  ships no JavaScript API, so projects on TypeScript 7 could not install or load
  Archer. Archer now brings its own TypeScript, and the project no longer needs
  to install it.

## 0.2.0 - 2026-10-24

### Breaking changes

- Renamed the package from `@usescherie/archer` to `@lucasacoutinho/archer`.
  Update imports, setup files, and preloads to the new scope. No public
  consumers of the old name exist; it was only published to a private registry.

### Changed

- Licensed Archer under Apache-2.0 and added a `NOTICE` file.
- Moved the repository to `github.com/lucasacoutinho/archer`.
- Publishing now targets the public npm registry through npm trusted
  publishing (OIDC) with provenance, replacing private GitHub Packages
  publication.

## 0.1.0 - 2026-07-31

- Initial release.
