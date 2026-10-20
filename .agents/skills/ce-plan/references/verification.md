# Plan verification

Use this checklist after writing a plan and before reporting completion.

1. **Structure**
   - Frontmatter contains required `title`, `type`, and `date`; `origin` is present when an origin document exists; `status` is absent.
   - Required sections and requirement IDs are present.
   - File paths are repository-relative.

2. **Substance**
   - Every confirmed requirement maps to one or more implementation units.
   - Each unit names concrete files or symbols, approach, tests, and dependencies.
   - Security, data lifecycle, migration, rollback, and failure behavior are explicit where relevant.
   - The plan avoids speculative abstractions and unrelated refactors.

3. **Operations**
   - Rollout order, compatibility windows, observability, and post-deploy verification are stated.
   - External dependencies and uncertain API assumptions are cited and called out.

4. **Formatting**
   - Markdown headings and anchors are stable.
   - Fenced blocks are balanced.
   - No task-progress `status:` fields appear below frontmatter.
   - `git diff --check` passes.

5. **Traceability**
   - Each requirement ID appears in the implementation-units coverage map.
   - Sources include the origin document plus relevant repository and external references.
