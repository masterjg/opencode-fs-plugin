# Installing the plugin and filesystem skill

The plugin ships the skill at:

```text
skills/filesystem/SKILL.md
```

OpenCode does not search inside an installed plugin package automatically, so
the plugin must be loaded and the skill directory must be registered.

## Install the plugin

### From npm

Add the registry package to the plugin list:

```jsonc
{
  "plugins": ["opencode-fs-plugin@1.2.0"]
}
```

Or let the CLI install and configure it:

```bash
opencode plugin add opencode-fs-plugin@1.2.0
```

A bare `opencode-fs-plugin` follows `latest`. OpenCode installs it into its
cache, which has no stable skill path; use the npm-install-in-a-project route in
Option A if you also want the skill.

### From a release tarball

Download the release artifact and install it as a normal npm package:

```bash
VERSION=1.2.0
curl -L -o "opencode-fs-plugin-${VERSION}.tgz" \
  "https://github.com/masterjg/opencode-fs-plugin/releases/download/v${VERSION}/opencode-fs-plugin-${VERSION}.tgz"
npm install "./opencode-fs-plugin-${VERSION}.tgz"
```

Add the installed directory to the OpenCode config:

```jsonc
{
  "plugins": ["./node_modules/opencode-fs-plugin"]
}
```

Plugin paths resolve from the config file that contains them, so use an absolute
path in the global config. The tarball contains `src/`, `skills/`, `SPEC.md` and
`INSTALL.md`; npm installs its runtime dependencies. Do not unpack it by hand.

OpenCode does not accept the release asset URL or a `.tgz` file directly in
`plugins`; install it with npm first and point at the installed directory.

### From a Git tag

Every release is tagged `v<version>`. Add the tag directly to the plugin list;
OpenCode installs it from Git:

```jsonc
{
  "plugins": ["github:masterjg/opencode-fs-plugin#v1.2.0"]
}
```

`opencode plugin add 'github:masterjg/opencode-fs-plugin#v1.2.0'` installs the
same spec and writes the entry for you. The equivalent full URL is
`git+https://github.com/masterjg/opencode-fs-plugin.git#v1.2.0`. A tag is
checked for updates; use a full commit hash to pin it.

Git plugins are installed under OpenCode's cache, so their package path is not
stable. For a stable skill path, install the tag with npm instead:

```bash
npm install "github:masterjg/opencode-fs-plugin#v1.2.0"
```

Then configure `./node_modules/opencode-fs-plugin` in `plugins` as in the
tarball section, and use the packaged skill path below.

### From a source checkout

```jsonc
{
  "plugins": ["./repos/opencode-fs-plugin"]
}
```

Use the absolute path if the checkout is outside the config directory.

## Install the skill

If you already use the config-repo copy at
`~/.config/opencode/skills/filesystem`, keep that one; it is already discovered.
The plugin copy is for standalone installs and for keeping the skill versioned
with the tools.

### Option A — register the packaged skills directory

For an npm, release-tarball, or Git-tag install in a project:

```jsonc
{
  "skills": ["./node_modules/opencode-fs-plugin/skills"]
}
```

For a source checkout:

```jsonc
{
  "skills": ["~/.config/opencode/repos/opencode-fs-plugin/skills"]
}
```

A plugin loaded straight from a `github:` spec has no stable package path, so
register the skill only for the tarball and npm installs above. Use an absolute
skill path when the plugin is installed globally, because relative skill paths
resolve from the active OpenCode working directory, not from the config file.
The skill ID is `filesystem`, derived from the directory name, not from the
frontmatter display name.

### Option B — symlink into the global discovery directory

OpenCode automatically discovers skills under `~/.config/opencode/skills`.

From a source checkout:

```bash
PLUGIN="${HOME}/.config/opencode/repos/opencode-fs-plugin"
mkdir -p "${HOME}/.config/opencode/skills"
ln -s "${PLUGIN}/skills/filesystem" "${HOME}/.config/opencode/skills/filesystem"
```

From a project install:

```bash
mkdir -p "${HOME}/.config/opencode/skills"
ln -s "$(pwd)/node_modules/opencode-fs-plugin/skills/filesystem" \
  "${HOME}/.config/opencode/skills/filesystem"
```

Use a symlink rather than a copy so updates to the installed package update the
active skill.

If `~/.config/opencode/skills/filesystem` already exists as a regular directory,
keep that copy or replace it deliberately; do not create a duplicate ID by
accident.

## Verify

Start a Worker session and load it explicitly:

```text
@filesystem
```

Or call the `skill` tool with:

```json
{ "id": "filesystem" }
```

The skill is advertised with its `description`; OpenCode shows only the ID, name
and description until the model loads it.

## Agent installation prompt

To let a coding agent install the plugin, use:

```text
Install opencode-fs-plugin 1.2.0 with "npm install opencode-fs-plugin@1.2.0",
or from its release tarball or the Git tag
"github:masterjg/opencode-fs-plugin#v1.2.0". Add
"./node_modules/opencode-fs-plugin" to the plugins array in opencode.jsonc, add
"./node_modules/opencode-fs-plugin/skills" to the skills array, then verify that
the filesystem skill loads with the skill tool using id "filesystem".
```

The agent should edit `opencode.jsonc` and verify the load; it should not copy
the Markdown by hand.
