# Changesets

Run `pnpm changeset` to describe a change to one or more published packages. Each changeset picks
a semver bump per package and becomes a changelog entry when the Version Packages PR is created.
All packages share one version (`fixed`), so any changeset bumps every package. See "Releasing" in
the root `README.md`.
