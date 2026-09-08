# Web Design Guide

> Review existing UI code for compliance with Vercel's Web Interface Guidelines.

## How It Works

1. **Fetch** the latest guidelines from the source URL below
2. **Read** the specified files (or prompt user for files/pattern)
3. **Check** against all rules in the fetched guidelines
4. **Output** findings in the terse `file:line` format

## Guidelines Source

Fetch fresh guidelines before each review using WebFetch:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

The fetched content contains all the rules and output format instructions.

## Usage

1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
