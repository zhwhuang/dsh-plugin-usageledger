/**
 * Browser half of dsh-plugin-apicost.
 *
 * Shipped as a harness client bundle (`window.__ModuleLoader__.load`), so this
 * module has no importable runtime exports; the declarations describe the
 * factory's export surface instead.
 */

/** Cordis services required by the browser half. */
export declare const inject: string[];

/**
 * Contribute the sidebar foot widget and the detail overlay.
 * @param ctx - client root context (`ctx.slots` is required).
 */
export declare function apply(ctx: { slots: { inject(name: string, callback: () => unknown): unknown; register(options: object, component: unknown): unknown } }): void;

/** The always-mounted sidebar seat; `wide === false` renders the collapsed rail form. */
export declare function SidebarCostWidget(props: { wide?: boolean; cost: unknown }): unknown;

/** The frame-wide detail panel; renders nothing while the store's `open` flag is false. */
export declare function ApiCostOverlay(props: { cost: unknown }): unknown;
