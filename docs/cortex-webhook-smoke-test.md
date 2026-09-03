# Cortex Webhook Smoke Test

This temporary document exercises the Cortex GitHub pull-request automation.

## Initial event

- Repository: `ShengQU-ASUS/loop-engineering`
- Expected GitHub action: `opened`
- Expected Cortex task type: `code_review`

No product behavior or release configuration is changed by this test.

## Follow-up event

- Change: this marker was updated after the pull request was opened.
- Expected GitHub action: `synchronize`
- Expected result: Cortex reviews the new pull-request head.
