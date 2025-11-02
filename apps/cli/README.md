## Preview Package

Publish and share local packages to a preview url easily
Just like [pkg.pr.new](https://pkg.pr.new) but local

### Usage

First, login using your Github account

```bash
pnpx preview-pkg login # Used Github for authentication
```

Then, publish your packages to a preview url

```bash
pnpx preview-pkg publish # Tries to publish current directory's package
pnpx preview-pkg publish 'packages/*' # Publish all packages in the packages directory
pnpx preview-pkg publish 'packages/*' --version custom-version # Publish all packages in the packages directory with a custom version (only non semantic versions are supported)
pnpx preview-pkg publish 'packages/*' --packer bun # Use a custom packer
pnpx preview-pkg publish 'packages/*' 'apps/*' # Specify multiple paths
```
