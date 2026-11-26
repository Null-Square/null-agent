# Upstream API Trust Algebra

Hold the consumer call path fixed and vary one recorded upstream property:

- identity/account binding;
- status code and content type;
- missing versus extra server-managed field;
- canonical versus duplicated field;
- signed raw bytes versus parser-normalized body;
- fixed provider host versus owner-controlled public redirect;
- fresh event versus one replayed event.

Use recorded or owner-hosted fixtures. No real-provider impersonation, discovered credentials, internal destinations, or uncontrolled downstream state.
