export type TemplateContextMap = WeakMap<Element, TemplateContext>;

export type CompiledFunction = Function & {
  source?: any;
};

/** Cached template computations */
export type TemplateContext = {
  /** Pre-transformed fragment from source template */
  fragment?: DocumentFragment;
  source?: Element;
  plugins: PluginInvocationMap;
};

type MaybePromise<T> = Promise<T> | T;

export type DynamicElementPluginResult<T> = T;

export type DynamicElementPlugin<T> = (
  input: DynamicElementPluginResult<T>,
  argument: unknown
) => MaybePromise<Partial<DynamicElementPluginResult<T>> | void>;

export type DynamicElementPluginResultMap = {
  compile: TemplateContext;
  init: DynamicElement;
};

export type DynamicElementPluginMap = {
  [T in keyof DynamicElementPluginResultMap]: {
    [name: string]: DynamicElementPlugin<DynamicElementPluginResultMap[T]>;
  };
};

export type PluginResult<K extends keyof DynamicElementPluginResultMap> =
  DynamicElementPluginResult<DynamicElementPluginResultMap[K]>;

export type Plugin<K extends keyof DynamicElementPluginResultMap> =
  DynamicElementPlugin<
    DynamicElementPluginResult<DynamicElementPluginResultMap[K]>
  >;

export type PluginInvocationMap = {
  [type: string]:
    | ([plugin: Plugin<any>, argument: unknown] | undefined)[]
    | undefined;
};

const array = Array.from;

const cloneNode = <T extends Node>(node: T): T => {
  return node.cloneNode(true) as T;
};

export default class DynamicElement extends HTMLElement {
  /** Global instance map used to get elements into scripts */
  static instance: { [id: string]: HTMLElement } = {};

  static install(tagName: string = "x-is") {
    customElements.define(
      tagName,
      // @ts-ignore
      (globalThis.DynamicElement = DynamicElement)
    );
  }

  static pluginMap: {
    [type: string]: {
      [name: string]: Plugin<any>;
    };
  } = {
    compile: {},
    init: {},
  } satisfies DynamicElementPluginMap;

  static registerPlugin<const K extends keyof DynamicElementPluginMap>(
    type: K,
    name: string,
    plugin: DynamicElementPluginMap[K][string]
  ) {
    this.pluginMap[type] ??= {};
    // @ts-ignore
    this.pluginMap[type][name] = plugin;
  }

  static async runPlugins<const K extends keyof DynamicElementPluginMap>(
    type: K,
    result: PluginResult<K>
  ): Promise<PluginResult<K>> {
    let pair: [plugin: Plugin<K>, argument: unknown] | undefined;
    while ((pair = result.plugins[type]?.shift())) {
      const [plugin, argument] = pair;
      const pluginResult = (await plugin(result, argument)) || {};
      Object.assign(result, pluginResult);
    }
    return result;
  }

  static getElementPluginMap($el: Element) {
    const plugins: {
      [type: string]: [plugin: Plugin<any>, argument: string][];
    } = {};
    for (const attr of array($el.attributes)) {
      const [plugin, type, name] = attr.name.split(":", 3);
      if (plugin === "plugin") {
        if (!DynamicElement.pluginMap[type]?.[name]) {
          console.warn(`plugin not found: ${type} ${name}`);
          continue;
        }
        plugins[type] ??= [];
        plugins[type].push([DynamicElement.pluginMap[type][name], attr.value]);
      }
    }
    return plugins satisfies PluginInvocationMap;
  }

  static async compile(
    source: Element,
    plugins: PluginInvocationMap
  ): Promise<TemplateContext> {
    return DynamicElement.runPlugins("compile", {
      fragment: new DocumentFragment(),
      source,
      plugins,
    });
  }

  /** Instance ID used in `DynamicElement.instance` */
  public _id: string = crypto.randomUUID();

  /** Shared copy of the source template context */
  public compile(): Promise<TemplateContext> {
    return DynamicElement.compile(this, this.plugins);
  }

  #plugins: PluginInvocationMap;
  public get plugins() {
    this.#plugins ??= DynamicElement.getElementPluginMap(this);
    return this.#plugins;
  }
  public set plugins(value) {
    this.#plugins = value;
  }

  /** Create DocumentFragment to be appended to the shadowRoot */
  public createFragment({
    fragment: sourceFragment,
  }: TemplateContext): DocumentFragment {
    const fragment = cloneNode<DocumentFragment>(sourceFragment!);

    // execute init script after all of the DOM loads
    const newScript = document.createElement("script");
    newScript.innerHTML = `DynamicElement.instance["${this._id}"].init()`;
    fragment.append(newScript);

    return fragment;
  }

  public init() {
    this.plugins = DynamicElement.combinePlugins(
      this.plugins,
      this.context.plugins
    );
    return DynamicElement.runPlugins("init", this);
  }

  /** Alias for shadowRoot */
  #shadow = this.attachShadow({
    mode: "open",
  });

  #fragment: DocumentFragment;
  public get fragment() {
    return this.#fragment;
  }
  public set fragment(value) {
    this.#fragment = value;
    this.#shadow.replaceChildren(value);
  }

  public context: TemplateContext;
  async connectedCallback() {
    const instance = this;
    DynamicElement.instance[instance._id] = instance;
    if (instance.fragment) {
      queueMicrotask(instance.init.bind(instance));
    } else {
      this.context = await instance.compile();
      instance.fragment = instance.createFragment(this.context);
    }
  }
  disconnectedCallback() {
    delete DynamicElement.instance[this._id];
    this.#dispatch("disconnected");
  }

  static combinePlugins(a: PluginInvocationMap, b: PluginInvocationMap) {
    return Object.fromEntries(
      array(new Set([...Object.keys(a), ...Object.keys(b)]), (type) => {
        return [type, (a[type] ?? []).concat(b[type] ?? [])];
      })
    );
  }

  #dispatch(type: string, eventInitDict?: CustomEventInit): boolean {
    return this.dispatchEvent(new CustomEvent(type, eventInitDict));
  }
}
