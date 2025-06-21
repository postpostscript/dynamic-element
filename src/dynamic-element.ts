export type TemplateContextMap = WeakMap<HTMLTemplateElement, TemplateContext>;

export type CompiledFunction = Function & {
  source: any;
};

/** Cached template computations */
export type TemplateContext = {
  /** Pre-transformed fragment from source template */
  fragment: DocumentFragment;

  /** Functions replacing original template scripts */
  methods: Set<CompiledFunction>;

  attrs: {
    [name: string]: string[] | undefined;
  };
};

const array = Array.from;

const getAttribute = (el: Element, name: string) => {
  return el.getAttribute(name);
};

const withQuerySelectorAll = <TElement extends Element, TResult>(
  query: string,
  callback: (element: TElement) => TResult,
  root: Pick<Element, "querySelectorAll"> = document
): TResult[] => {
  return array(root.querySelectorAll(query) as NodeListOf<TElement>, callback);
};

const cloneNode = <T extends Node>(node: T): T => {
  return node.cloneNode(true) as T;
};

export default class DynamicElement extends HTMLElement {
  /** Global instance map used to get elements into scripts */
  static instance: { [id: string]: HTMLElement } = {};

  /** Global template templateContext map used to cache template computations */
  static #templates = new WeakMap<HTMLTemplateElement, TemplateContext>();

  static install(tagName: string = "x-is") {
    customElements.define(
      tagName,
      (globalThis.DynamicElement = DynamicElement)
    );
  }

  static compile(template: HTMLTemplateElement): TemplateContext {
    const cached = DynamicElement.#templates.get(template);
    if (cached) {
      return cached;
    }

    let result: TemplateContext = {
      fragment: cloneNode<DocumentFragment>(template.content),
      methods: new Set(),
      attrs: Object.fromEntries(
        array(template.attributes, (attr) => [attr.name, [attr.value]])
      ),
      name: template.getAttribute("id"),
    };

    withQuerySelectorAll(
      "script:not([src])",
      (script: HTMLScriptElement) => {
        const type = getAttribute(script, "type");
        if ([null, "text/javascript", "module"].includes(type)) {
          let code = `{${script.innerHTML}}`;
          if (type === "module") {
            code = `return(async()=>${code})()`;
          }
          const method = Function(code) as CompiledFunction;
          method.source = template;
          result!.methods.add(method);
          script.remove();
        }
      },
      result.fragment
    );

    const extend = getAttribute(template, "extend");

    if (extend) {
      result = DynamicElement.combine([DynamicElement.load(extend), result]);
    }

    DynamicElement.#templates.set(template, result);

    return result;
  }

  static combine(templateContexts: TemplateContext[]): TemplateContext {
    const fragment: TemplateContext["fragment"] = new DocumentFragment();
    const methods = new Set<CompiledFunction>();
    const attrs: TemplateContext["attrs"] = {};

    console.log("combine", templateContexts);

    templateContexts.forEach((context) => {
      fragment.append(context.fragment);
      for (const method of context.methods) {
        methods.add(method);
      }
      for (const attrName in context.attrs) {
        attrs[attrName] ??= [];
        attrs[attrName].push(...context.attrs[attrName]!);
      }
    });

    return {
      fragment,
      methods,
      attrs,
      name: templateContexts.map((c) => c.name).join(", "),
    };
  }

  static load(src: string): TemplateContext {
    return DynamicElement.combine(
      withQuerySelectorAll(src, DynamicElement.compile)
    );
  }

  /** Instance ID used in `DynamicElement.instance` */
  public _id: string = crypto.randomUUID();

  /** Shared copy of the source template context */
  public compile(): TemplateContext {
    return DynamicElement.load(getAttribute(this, "src")!);
  }

  public methods: Function[];

  /** Create DocumentFragment to be appended to the shadowRoot */
  public createFragment({
    fragment: sourceFragment,
    methods,
  }: TemplateContext): DocumentFragment {
    const fragment = cloneNode<DocumentFragment>(sourceFragment);

    this.methods = array(methods);
    // execute init script after all of the DOM loads
    const newScript = document.createElement("script");
    newScript.innerHTML = `DynamicElement.instance["${this._id}"].init()`;
    fragment.append(newScript);

    return fragment;
  }

  /** Execute the script Function equivalents with `this` accessible */
  #init = Promise.resolve();
  public async init() {
    this.#init = this.#init.then(() => {
      const instance = this;
      let fn: Function;
      while ((fn = instance.methods.shift()!)) {
        try {
          const result = fn.call(instance);
          console.log({ code: fn.toString(), result });
        } catch (error) {
          instance.errorCallback(fn as CompiledFunction, error);
        }
      }
    });
  }

  /** Alias for shadowRoot */
  #shadow = this.attachShadow({
    mode: "open",
  });

  #fragment: DocumentFragment;

  connectedCallback() {
    const instance = this;
    DynamicElement.instance[instance._id] = instance;
    if (instance.#fragment) {
      queueMicrotask(instance.init.bind(instance));
    } else {
      instance.#fragment = instance.createFragment(instance.compile());
      instance.#shadow.append(instance.#fragment);
    }
    instance.methods.push(() => {
      instance.#dispatch("connected");
    });
  }
  disconnectedCallback() {
    delete DynamicElement.instance[this._id];
    this.#dispatch("disconnected");
  }

  errorCallback(fn: CompiledFunction, error: Error) {
    let location: [line: number, column: number] = [
      error.lineNumber,
      error.columnNumber,
    ]; // firefox

    if (!location[0]) {
      // chrome
      const match =
        error.stack?.match(/anonymous\>:(\d+):(\d+)[^\n]*(\n[^\n]*init|$)/) ??
        [];
      location = [parseInt(match[1]), parseInt(match[2])];
    }

    const context = location[0]
      ? [
          fn.source,
          "\n" +
            `${fn}`.split(/\n/g).at(location[0] - 1) +
            "\n" +
            " ".repeat(location[1] - 1) +
            `^\n`,
        ]
      : [];

    console.error("Error in", this, ...context, error);
    this.#dispatch("error", {
      detail: {
        error,
      },
    });
  }

  #dispatch(type: string, eventInitDict?: CustomEventInit): boolean {
    return this.dispatchEvent(new CustomEvent(type, eventInitDict));
  }
}
