# Secondary Server Injection Methodology

This package owns LDAP filter, XPath/XML-data, SSI, expression/format-string, and mail-protocol injection when no dedicated class owns the primitive. Select exactly one module per mission.

## Preconditions and Fast Applicability

Require a confirmed sink family from protocol behavior, source, or a paired error/control; a stable baseline; evaluator-owned data; and a safe marker. Default cap is eight requests per module. Do not infer the sink from a technology banner.

## Surface Discovery and Prioritization

- LDAP: directory-backed search/login filters and filter construction.
- XPath: XML-backed selectors distinct from external entity resolution.
- SSI: server-parsed template/include fields in a disposable fixture.
- Expression/format: evaluator canary functions or harmless formatting differentials.
- Mail: header/envelope fields with an evaluator mailbox and no third-party recipient.

## Safe Test Ladder

1. Establish normal, nonexistent, and syntax-neutral controls.
2. Introduce one delimiter for the selected grammar.
3. Compare paired true/false or literal/interpreted markers.
4. Use a second grammar-equivalent marker.
5. Corroborate the parser/sink with source or protocol evidence.
6. For mail, verify only the evaluator mailbox’s parsed headers.
7. Stop before command, file, network, or bulk-directory effects.

## Variation Matrix

| Module | Bounded variation |
|---|---|
| LDAP | escaped literal, paired filter truth values |
| XPath | quoted literal, paired predicate |
| SSI | literal marker, owner canary directive |
| expression/format | literal, harmless numeric/string evaluation |
| mail | display name, subject, one inert evaluator header |

## Proof Standard

Proof requires parser-specific behavior plus matched controls and objective evaluator-owned data/action or harmless canary interpretation. Generic errors, delimiter reflection, authentication differences without identity proof, or protocol banners are leads only.

## False Positives and Benign Lookalikes

- application search syntax can resemble LDAP/XPath;
- validators can emit parser names before execution;
- template delimiters can be escaped and reflected;
- localization formatting can change output;
- mail gateways can add headers independently;
- empty searches can match documented defaults.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when the sink family cannot be identified, evaluator data/mailbox is absent, or safe canary interpretation is unavailable. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `http_payload` for paired inputs, browser tooling for ordinary forms, mail capture only for the evaluator mailbox, and `file_read` for source traces. Do not use broad payload lists.

## Handoffs and Duplicate Prevention

Hand XXE to `xxe`, SQL/NoSQL/command/SSTI to their owners, header splitting to `header-injection`, and SMTP authorization to its protocol/platform owner.

## Stop, Cleanup, and Data Minimization

Stop at one reproduced module proof, eight requests, or parser instability. Remove evaluator messages/data and retain only minimal parser evidence.

Never perform destructive actions, directory dumping, command execution, or mail to non-evaluator recipients.

Research date: 2026-07-23

## Sources

- OWASP WSTG, LDAP Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/06-Testing_for_LDAP_Injection
- OWASP WSTG, XPath Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/09-Testing_for_XPath_Injection
- OWASP WSTG, IMAP/SMTP Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/10-Testing_for_IMAP_SMTP_Injection
