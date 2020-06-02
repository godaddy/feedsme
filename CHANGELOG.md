# CHANGELOG

- Be more defensive with dependent data structure

### 4.0.1

- Make clone a dep instead of devDep

### 4.0.0
- [#31]: Update to use dynamodb based warehouse-models
- [#26] Fix subtle bug in edge case handling to exclude the version being published
- [#25] Fix edge case for current -> previous -> current package publishes
  with proper auto triggering of dependent builds

- [#23] Update `README.md` and add badges.
  - Use `@wrhs/diagrams` to generate mermaid charts.
  - Update patch/minor dependencies to mitigate security warnings.

- [#22] Default documenation
  - Add: `CONTRUBUTING.md`, `CHANGELOG.md`, `SECURITY.md`
  - update `LICENSE` year
  - add `.github` templates
  - Give credits for Github templates

[#22]: https://github.com/godaddy/feedsme/pull/22
[#23]: https://github.com/godaddy/feedsme/pull/23
[#25]: https://github.com/godaddy/feedsme/pull/25
[#26]: https://github.com/godaddy/feedsme/pull/26
[#31]: https://github.com/godaddy/feedsme/pull/31
