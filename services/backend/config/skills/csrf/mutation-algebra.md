# CSRF Mutation Algebra

Keep the evaluator action harmless and change one browser binding at a time:

1. valid token with evaluator session;
2. missing token;
3. token from a second evaluator session;
4. changed `Origin`/`Referer` through an owner test origin;
5. simple form content type versus the canonical content type;
6. top-level navigation versus subresource request, when applicable.

Confirm state with a fresh read and reset it. Stop after one successful cross-site action or eight attempts; do not target login, password, payment, or real-user actions.
