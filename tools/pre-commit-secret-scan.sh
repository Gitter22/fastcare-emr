#!/usr/bin/env bash
# Pre-commit secret-scanning hook (Agile_EMR_Full_System_Build_Prompt.md
# Step 0, Task 8 -- closes Risk Management Plan item I4). Fails CLOSED: if
# gitleaks isn't installed, the commit is blocked with install instructions
# rather than silently letting the commit through unscanned.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "----------------------------------------------------------------------"
  echo "BLOCKED: gitleaks is not installed, so staged changes cannot be"
  echo "secret-scanned before commit (see risk I4 in"
  echo "Agile_EMR_Risk_Management_Plan.docx)."
  echo
  echo "Install it, then retry the commit:"
  echo "  macOS:   brew install gitleaks"
  echo "  Linux:   see https://github.com/gitleaks/gitleaks#installing"
  echo "----------------------------------------------------------------------"
  exit 1
fi

gitleaks git --pre-commit --redact --staged --verbose
