# work-experience/ — your raw career corpus (optional)

This folder feeds the optional **compile step**
(`cd backend && npx tsx src/profile/compileProfile.ts`), which extracts additional,
deduplicated résumé bullets from raw material and merges them into
`backend/data/master-profile.json`. Nothing here is committed: the folder is gitignored
except this README and `compile-config.example.json`.

The compile step is **add-only**: it never creates employers, changes dates or titles, or
invents metrics. Employers must already exist in `master-profile.json`.

## Layout the compiler expects

```
work-experience/
├── README.md                     ← this file (skipped by the compiler)
├── compile-config.json           ← employer aliases + codename glossary (copy the example)
├── behavioral-interview-scripts.md   ← optional; the /apply skill reads it for free-text answers
├── <employer-a>/
│   ├── source-kit.md             ← read first: projects, evidence, metrics, glossary
│   ├── prior-resume-notes.md     ← read second: earlier draft bullets
│   ├── references/               ← copied design docs, READMEs, incident reports
│   └── git-evidence/             ← commit logs etc. (skipped by the compiler)
└── <employer-b>/
    └── source-kit.md
```

Only `*.md` files are read, in this priority: `source-kit.md`, then `prior-resume-notes.md`,
then everything else. `README.md` files and `git-evidence/` directories are skipped. Each file
is truncated to 16k characters and the whole corpus to 90k, so put the strongest material in
the source kits.

## Writing a source kit

- One section per project: what it was, your role, the stack, the outcome.
- Mark any number you have not verified with `⚠️VERIFY`; the compiler is told to drop or
  soften those.
- List internal codenames and what they mean in plain terms, then add the same mapping to
  `compile-config.json` so the LLM translates them instead of leaking them into a résumé.
