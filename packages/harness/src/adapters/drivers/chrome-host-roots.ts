import { extractFirstJsonObject } from "../../core/json.js";
import { errorKindOf, stepError } from "../../core/errors.js";
import { HOST_ROOT_REGISTRY, type HostOwnedRootScope } from "./host-owned-roots.js";
import { DOM_FOREGROUND_PROBE } from "./dom-foreground.js";
import { documentTopology } from "./chrome-documents.js";
import { virtualAXRoles } from "./chrome-ax.js";

type Row = { uid: string; role: string; name: string };
type Call = (name: string, args?: Record<string, unknown>) => Promise<string>;
interface State { stamp: string; active: number; unsupported: boolean }

/** The one exclusion boundary used by compact/full capture, freeze, lookup and dispatch. */
export class ChromeHostRoots {
  stamp?: string;
  active = false;
  private textUids = new Set<string>();
  private readonly registry: string;
  constructor(scope: HostOwnedRootScope, private readonly call: Call, private readonly rows: (raw: string) => Row[]) {
    if (!/^cairn:host-roots:[a-zA-Z0-9-]+$/.test(scope.key)) throw new Error("Invalid host-owned root scope");
    this.registry = `(${HOST_ROOT_REGISTRY})(${JSON.stringify(scope.key)})`;
  }

  private async evaluate(body: string, args: string[] = []): Promise<Record<string, unknown>> {
    try {
      const reply = await this.call("evaluate_script", {
        function: `(...nodes) => { const registry = ${this.registry}; const status = registry.status(); ${body} }`, args,
      });
      const result = extractFirstJsonObject(reply);
      if (!result || typeof result !== "object") throw new Error("Host ownership measurement unavailable");
      return result as Record<string, unknown>;
    } catch (error) {
      if (errorKindOf(error) === "transport") throw error;
      // Measurement failures are not a missing locator that self-healing may bypass.
      throw stepError("handler", `Host ownership measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private check(value: Record<string, unknown>, expected?: string): State {
    if (typeof value.stamp !== "string" || typeof value.active !== "number" || typeof value.unsupported !== "boolean") {
      throw stepError("handler", "Host ownership measurement incomplete");
    }
    if (value.unsupported) throw stepError("handler", "Host-owned root exclusion does not support active frame boundaries");
    if (expected !== undefined && value.stamp !== expected) {
      throw stepError("handler", "Host ownership changed: capture a new observation before resolving targets");
    }
    return value as unknown as State;
  }

  async assertStamp(expected?: string): Promise<string> {
    return this.check(await this.evaluate("return status;"), expected).stamp;
  }

  async filter(raw: string, expected?: string): Promise<string> {
    const status = this.check(await this.evaluate("return status;"), expected);
    this.stamp = status.stamp;
    this.active = status.active > 0;
    const parsed = this.rows(raw);
    this.textUids = new Set(parsed.filter(row => row.role === "StaticText").map(row => row.uid));
    if (!status.active) return raw;
    if (documentTopology(raw).framed) throw stepError("handler", "Host-owned root exclusion does not support active frame boundaries");
    // MCP may assign the same UID to unrelated generated text (including app and
    // host text). Never guess which row that handle identifies or expose it as a ref.
    const seen = new Set<string>(), excluded = new Set<string>();
    // The candidate parser only returns quoted-name rows; inspect unnamed AX
    // wrappers too, since they may share the virtual UID with a named text row.
    for (const line of raw.split("\n")) {
      const match = line.match(/uid=(\S+)\s+(\w+)/);
      if (!match) continue;
      const [, uid, role] = match as [string, string, string];
      if (seen.has(uid) || virtualAXRoles.has(role)) excluded.add(uid);
      seen.add(uid);
    }
    let rows = parsed.filter(row => !excluded.has(row.uid));
    let reply: Record<string, unknown>;
    for (;;) {
      try {
        reply = await this.evaluate(`const textRows = ${JSON.stringify(rows.map(row => row.role === "StaticText"))};
          return { ...status, excluded: nodes.map((node, i) => registry.excluded(node, textRows[i])) };`, rows.map(row => row.uid));
        break;
      } catch (error) {
        // Compact AX has no virtual-role annotation for CSS-generated StaticText.
        // Only MCP's precise node-resolution failure may remove that text UID.
        // Real controls, mixed-frame errors, registry failures and transport errors
        // remain fatal. Each retry removes a UID, so no unbounded retry is possible.
        const uid = errorKindOf(error) === "handler" && error instanceof Error
          ? error.message.match(/^Host ownership measurement failed: MCP evaluate_script failed: (?:Error: )?Element with uid (\S+) no longer exists on the page\.$/)?.[1]
          : undefined;
        if (!uid || !rows.some(row => row.uid === uid && row.role === "StaticText")) throw error;
        excluded.add(uid);
        rows = rows.filter(row => row.uid !== uid);
        await this.assertStamp(status.stamp);
      }
    }
    this.check(reply, status.stamp);
    if (!Array.isArray(reply.excluded) || reply.excluded.length !== rows.length || reply.excluded.some(value => typeof value !== "boolean")) {
      throw stepError("handler", "Host ownership candidate measurement incomplete");
    }
    rows.forEach((row, i) => { if ((reply.excluded as boolean[])[i]) excluded.add(row.uid); });
    return raw.split("\n").filter(line => {
      const match = line.match(/uid=(\S+)\s+(\w+)/);
      return !match || !excluded.has(match[1]!);
    }).join("\n");
  }

  async assertNode(uid: string, dispatch = false, expected?: string): Promise<void> {
    // With no registrations, a frame UID must not evaluate the registry in the child's
    // different global and accidentally compare its token with the top document's token.
    const status = this.check(await this.evaluate("return status;"), expected);
    if (!status.active) return;
    const reply = await this.evaluate(`
      const el = nodes[0]?.nodeType === 3 ? nodes[0].parentElement : nodes[0];
      let allowed = !!el && !registry.excluded(nodes[0], ${this.textUids.has(uid)});
      if (allowed && ${dispatch}) {
        const b = el.getBoundingClientRect(), x = b.x + b.width/2, y = b.y + b.height/2;
        const top = document.elementFromPoint(x,y);
        // Refuse automatic offscreen scrolling while ownership is active: its future hit
        // point cannot be established here. The caller may explicitly scroll and recapture.
        allowed = b.width > 0 && b.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !!top && !registry.excluded(top);
      }
      return {...status, allowed};`, [uid]);
    this.check(reply, status.stamp);
    if (reply.allowed !== true) throw stepError("handler", "Host-owned or host-obstructed target refused (or target geometry unavailable)");
  }

  async selector(rows: Row[], selector: string): Promise<string | undefined> {
    const reply = await this.evaluate(`
      const selected = document.querySelector(${JSON.stringify(selector)});
      if (selected && status.active && registry.excluded(selected)) return {...status, blocked:true};
      return {...status, index:nodes.findIndex(node => node === selected)};`, rows.map(row => row.uid));
    this.check(reply, this.stamp);
    if (reply.blocked) throw stepError("handler", "Selector resolves to host-owned content");
    return typeof reply.index === "number" ? rows[reply.index]?.uid : undefined;
  }

  async reachable(rows: Row[]): Promise<{ reachable: string[]; occluded: string[]; unknown: string[] }> {
    const reply = await this.evaluate(`
      const facts = (${DOM_FOREGROUND_PROBE})(...nodes);
      const textRows = ${JSON.stringify(rows.map(row => row.role === "StaticText"))};
      return {...status, facts: facts.map((fact, i) => registry.excluded(nodes[i], textRows[i]) ? {} : fact)};`, rows.map(row => row.uid));
    this.check(reply, this.stamp);
    if (!Array.isArray(reply.facts) || reply.facts.length !== rows.length) throw stepError("handler", "Host-safe hit test unavailable");
    const buckets = { reachable: [] as string[], occluded: [] as string[], unknown: [] as string[] };
    rows.forEach((row, i) => {
      const fact = (reply.facts as Array<{ occluded?: boolean }>)[i];
      buckets[fact?.occluded === false ? "reachable" : fact?.occluded === true ? "occluded" : "unknown"].push(row.role);
    });
    return buckets;
  }

  async keyboard(key: string): Promise<void> {
    const reply = await this.evaluate(`
      let focus = document.activeElement;
      while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
      return {...status, blocked:status.active > 0 && (registry.owns(focus) || ${JSON.stringify(key)}.split('+').some(part => part.trim().toLowerCase() === 'tab'))};`);
    this.check(reply);
    if (reply.blocked) throw stepError("handler", "Keyboard input into host-owned UI or Tab traversal with active ownership is unsupported");
  }
}
