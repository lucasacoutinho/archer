# Changelog

## 0.2.0 - Unreleased

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
