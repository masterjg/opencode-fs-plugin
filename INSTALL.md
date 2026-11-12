# Installing the filesystem skill

The plugin ships the skill at:

```text
skills/filesystem/SKILL.md
```

OpenCode does not search inside an installed plugin package automatically. To
make the `filesystem` skill discoverable, either register the plugin's
`skills` directory or link the skill into the global discovery directory.

If you already use the config-repo copy at
`~/.config/opencode/skills/filesystem`, keep that one; it is already discovered.
The plugin copy is for standalone installs and for keeping the skill versioned
with the tools.

## Option A — register the plugin skills directory

Add this to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "skills": [
    "~/.config/opencode/repos/opencode-fs-plugin/skills"
  ]
}
```

If your plugin is not under `~/.config/opencode/repos/`, use its absolute path.
The skill ID is `filesystem`, derived from the directory name, not from the
frontmatter display name.

This is the recommended option when the plugin is tracked as a submodule,
because updates to the plugin also update the skill.

## Option B — symlink into the global discovery directory

OpenCode automatically discovers skills under `~/.config/opencode/skills`.

```bash
PLUGIN="${HOME}/.config/opencode/repos/opencode-fs-plugin"
mkdir -p "${HOME}/.config/opencode/skills"
ln -s "${PLUGIN}/skills/filesystem" "${HOME}/.config/opencode/skills/filesystem"
```

Use a symlink rather than a copy so `git pull` updates the active skill.

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

To let a coding agent install it, use:

```text
Add "~/.config/opencode/repos/opencode-fs-plugin/skills" to the skills array in
~/.config/opencode/opencode.jsonc, then verify that the filesystem skill loads
with the skill tool using id "filesystem".
```

The agent should edit `opencode.jsonc` and verify the load; it should not copy
the Markdown by hand.
