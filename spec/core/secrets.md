# Secrets — fill at run time, never freeze (#174)

`type` steps freeze their text as-is, so a discovered login commits the password into the skill
file, and with the CLI a skill lives in the repo. The engine cannot know what counts as a secret;
what it can do is honour a contract for the half everyone otherwise re-implements.

**Contract.** `{name}` in a `type` step's text is a placeholder — a bare identifier in braces,
nothing else, so typed JSON or a regex quantifier passes through; `{{name}}` types the literal
`{name}` for a form that really wants braces. The run supplies values (`secrets: Record<string,
string | { value, origin }>` on `runScenario`, `runHarness`, `runSuite`, `discover`,
`LlmStepHealer`; `--secret name=value` and `CAIRN_SECRET_<NAME>` on the CLI). The driver receives
the value; the step, and so the skill, the trace, and the progress event, keep the placeholder.
This is a behaviour change for a skill that typed a bare `{word}` literally before: it now fails
closed until the value is supplied or the text is escaped.

**The page the model sees.** A browser masks `<input type="password">` in its own accessibility
tree, but a username, a token, an OTP, or a password field a site implements as plain text comes
back verbatim in the next snapshot. Any element name or value equal to a provided secret is
rendered as its placeholder before the model sees it, in discovery and in the step healer.

**Discovery.** The intent says `{password}`; the model echoes it in its `type` decision; the driver
types the value; the freeze writes the placeholder. Should the model echo the value instead (it
may have seen it in a plain-text field), the freeze puts the placeholder back: the engine knows
the exact value, so the substitution is unambiguous. Slotting a literal that was frozen before
the value was ever provided is the host's job — the engine never guesses which text was a secret.

**Fail closed, twice.** A placeholder with no value is the host's wiring: the step fails with
`errorKind: "handler"` (`environment`, exit 4), discovery aborts rather than spending its step
budget on a wall the model cannot climb, and outcome-heal does not run — a re-discovery cannot
supply a secret (#186's reasoning, #173's class). A scoped secret (`{ value, origin }`) is
refused on any page outside its site — the #184 boundary (`onSiteOf`: the host or a subdomain of
it), plus the port when the origin names one, since two local apps differ only by port — during
discovery and replay alike: a flow that ends at a payment provider and meets the provider's login
form must not be handed the app's credentials, and a prompt saying "only on our site" is a
request, not a guarantee. The refusal is a step failure the model can route around (`script`,
exit 3 on replay: the frozen step would type a secret where it does not belong); its message
names the page as origin+path, never the query, because provider callbacks carry tokens there.
