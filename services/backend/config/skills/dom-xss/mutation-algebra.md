# DOM XSS Mutation Algebra

Trace before mutating:

- source: fragment, query, storage, or `postMessage`;
- transform: decode, parse, concatenate, template expansion;
- sink: `innerHTML`, `insertAdjacentHTML`, script URL, or dynamic code;
- context: HTML text, attribute, URL, or JavaScript string;
- control: safe text API or rejected origin.

Use an inert DOM element marker and one source/context at a time. Stop after one deterministic source-to-sink trace; never read cookies or call the network.
