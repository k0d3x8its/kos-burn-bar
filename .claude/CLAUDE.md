# kos-burn-bar — Claude Config

## Project Overview
**Type:** Obsidian Plugin
**Stack:** JavaScript + Obsidian Plugin API
**Goal:** Token burn progress bar for Claude Code. Reads ~/.claude session logs and displays a live burn meter showing your 5-hour rolling window usage.

## Conventions
- Commit format: conventional commits (feat:, fix:, docs:, chore:)
- Branch naming: feature/, fix/, docs/, chore/
- NEVER add `Co-Authored-By` lines to commit messages
- Code comments: explain the why, not the what

## Trello
- Board: Kodex OS

## Skills
- `/sync-trello` — push .work/PLAN.md Goals to Trello
- `/handoff`     — end-of-session context preservation
- `/plan`        — create/update .work/PLAN.md

## Session Rules
- Always read .work/PLAN.md, .work/FINDINGS.md, and .work/PROGRESS.md if they exist
- When I paste a re-entry prompt, treat it as ground truth for project state

## Current State
See .work/PLAN.md for active goals and progress.
See .memory/SESSION-LOG.md for recent session history.
