var app = (function () {
    'use strict';

    function noop() { }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }

    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function destroy_each(iterations, detaching) {
        for (let i = 0; i < iterations.length; i += 1) {
            if (iterations[i])
                iterations[i].d(detaching);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.wholeText !== data)
            text.data = data;
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    let flushing = false;
    const seen_callbacks = new Set();
    function flush() {
        if (flushing)
            return;
        flushing = true;
        do {
            // first, call beforeUpdate functions
            // and update components
            for (let i = 0; i < dirty_components.length; i += 1) {
                const component = dirty_components[i];
                set_current_component(component);
                update(component.$$);
            }
            set_current_component(null);
            dirty_components.length = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        flushing = false;
        seen_callbacks.clear();
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    let outros;
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
    }
    function create_component(block) {
        block && block.c();
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = on_mount.map(run).filter(is_function);
                if (on_destroy) {
                    on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(parent_component ? parent_component.$$.context : options.context || []),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false
        };
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    /**
     * Base class for Svelte components. Used when dev=false.
     */
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set($$props) {
            if (this.$$set && !is_empty($$props)) {
                this.$$.skip_bound = true;
                this.$$set($$props);
                this.$$.skip_bound = false;
            }
        }
    }

    /* src\Components\Navbar\Navbar.svelte generated by Svelte v3.37.0 */

    function get_each_context$4(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[2] = list[i];
    	return child_ctx;
    }

    // (27:10) {#each navlists as list}
    function create_each_block$4(ctx) {
    	let li;
    	let a;
    	let t0_value = /*list*/ ctx[2].label + "";
    	let t0;
    	let a_href_value;
    	let t1;

    	return {
    		c() {
    			li = element("li");
    			a = element("a");
    			t0 = text(t0_value);
    			t1 = space();
    			attr(a, "class", "nav-link light-color svelte-1l52lkz");
    			attr(a, "href", a_href_value = /*list*/ ctx[2].url);
    			attr(li, "class", "nav-item svelte-1l52lkz");
    		},
    		m(target, anchor) {
    			insert(target, li, anchor);
    			append(li, a);
    			append(a, t0);
    			append(li, t1);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*navlists*/ 1 && t0_value !== (t0_value = /*list*/ ctx[2].label + "")) set_data(t0, t0_value);

    			if (dirty & /*navlists*/ 1 && a_href_value !== (a_href_value = /*list*/ ctx[2].url)) {
    				attr(a, "href", a_href_value);
    			}
    		},
    		d(detaching) {
    			if (detaching) detach(li);
    		}
    	};
    }

    function create_fragment$7(ctx) {
    	let section;
    	let nav;
    	let a;
    	let t0;
    	let t1;
    	let button;
    	let t2;
    	let div;
    	let ul;
    	let each_value = /*navlists*/ ctx[0];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$4(get_each_context$4(ctx, each_value, i));
    	}

    	return {
    		c() {
    			section = element("section");
    			nav = element("nav");
    			a = element("a");
    			t0 = text(/*header*/ ctx[1]);
    			t1 = space();
    			button = element("button");
    			button.innerHTML = `<span class="navbar-toggler-icon"></span>`;
    			t2 = space();
    			div = element("div");
    			ul = element("ul");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr(a, "class", "navbar-brand company_brand");
    			attr(a, "href", "/");
    			attr(button, "class", "navbar-toggler");
    			attr(button, "type", "button");
    			attr(button, "data-toggle", "collapse");
    			attr(button, "data-target", "#navbarNav");
    			attr(button, "aria-controls", "navbarNav");
    			attr(button, "aria-expanded", "false");
    			attr(button, "aria-label", "Toggle navigation");
    			attr(ul, "class", "navbar-nav ml-auto svelte-1l52lkz");
    			attr(div, "class", "collapse navbar-collapse");
    			attr(div, "id", "navbarNav");
    			attr(nav, "class", "navbar main-bgcolor navbar-expand-md navbar-dark svelte-1l52lkz");
    			attr(section, "id", "nav-bar");
    			attr(section, "class", "svelte-1l52lkz");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, nav);
    			append(nav, a);
    			append(a, t0);
    			append(nav, t1);
    			append(nav, button);
    			append(nav, t2);
    			append(nav, div);
    			append(div, ul);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(ul, null);
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*header*/ 2) set_data(t0, /*header*/ ctx[1]);

    			if (dirty & /*navlists*/ 1) {
    				each_value = /*navlists*/ ctx[0];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$4(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$4(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(ul, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$6($$self, $$props, $$invalidate) {
    	let { navlists = [] } = $$props;
    	let { header } = $$props;

    	$$self.$$set = $$props => {
    		if ("navlists" in $$props) $$invalidate(0, navlists = $$props.navlists);
    		if ("header" in $$props) $$invalidate(1, header = $$props.header);
    	};

    	return [navlists, header];
    }

    class Navbar extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$6, create_fragment$7, safe_not_equal, { navlists: 0, header: 1 });
    	}
    }

    /* src\Components\Banner\Banner.svelte generated by Svelte v3.37.0 */

    function create_fragment$6(ctx) {
    	let section;
    	let div3;
    	let div2;
    	let div0;
    	let h1;
    	let t1;
    	let p;
    	let t3;
    	let a;
    	let i;
    	let t4;
    	let t5;
    	let t6;
    	let div1;
    	let t7;
    	let img1;
    	let img1_src_value;

    	return {
    		c() {
    			section = element("section");
    			div3 = element("div");
    			div2 = element("div");
    			div0 = element("div");
    			h1 = element("h1");
    			h1.textContent = `${/*HEADING*/ ctx[0]}`;
    			t1 = space();
    			p = element("p");
    			p.textContent = `${/*DECRIPTION*/ ctx[1]}`;
    			t3 = space();
    			a = element("a");
    			i = element("i");
    			t4 = space();
    			t5 = text(/*WATCH_TUTORIAL*/ ctx[3]);
    			t6 = space();
    			div1 = element("div");
    			div1.innerHTML = `<img src="images/home.png" alt="" class="img-fluid"/>`;
    			t7 = space();
    			img1 = element("img");
    			attr(h1, "class", "svelte-10zo7rz");
    			attr(i, "class", "far fa-play-circle fa-2x watch-btn svelte-10zo7rz");
    			attr(a, "href", /*TUTORIAL_URL*/ ctx[2]);
    			attr(a, "target", "_blank");
    			attr(a, "class", "light-color svelte-10zo7rz");
    			attr(div0, "class", "col-md-6");
    			attr(div1, "class", "col-md-6");
    			attr(div2, "class", "row");
    			attr(div3, "class", "container");
    			if (img1.src !== (img1_src_value = "images/wave1.png")) attr(img1, "src", img1_src_value);
    			attr(img1, "alt", "");
    			attr(img1, "class", "wave-img svelte-10zo7rz");
    			attr(section, "class", "main-bgcolor light-color svelte-10zo7rz");
    			attr(section, "id", "banner");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, div3);
    			append(div3, div2);
    			append(div2, div0);
    			append(div0, h1);
    			append(div0, t1);
    			append(div0, p);
    			append(div0, t3);
    			append(div0, a);
    			append(a, i);
    			append(a, t4);
    			append(a, t5);
    			append(div2, t6);
    			append(div2, div1);
    			append(section, t7);
    			append(section, img1);
    		},
    		p: noop,
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    		}
    	};
    }

    function instance$5($$self, $$props, $$invalidate) {
    	let { bannerData = {} } = $$props;
    	const { HEADING, DECRIPTION, TUTORIAL_URL, WATCH_TUTORIAL } = bannerData;

    	$$self.$$set = $$props => {
    		if ("bannerData" in $$props) $$invalidate(4, bannerData = $$props.bannerData);
    	};

    	return [HEADING, DECRIPTION, TUTORIAL_URL, WATCH_TUTORIAL, bannerData];
    }

    class Banner extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$5, create_fragment$6, safe_not_equal, { bannerData: 4 });
    	}
    }

    /* src\Components\Services\Services.svelte generated by Svelte v3.37.0 */

    function get_each_context$3(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[4] = list[i];
    	return child_ctx;
    }

    // (15:8) {#each SERVICE_LIST as list}
    function create_each_block$3(ctx) {
    	let div;
    	let img;
    	let img_src_value;
    	let t0;
    	let h4;
    	let t1_value = /*list*/ ctx[4].LABEL + "";
    	let t1;
    	let t2;
    	let p;
    	let t3_value = /*list*/ ctx[4].DESCRIPTION + "";
    	let t3;
    	let t4;

    	return {
    		c() {
    			div = element("div");
    			img = element("img");
    			t0 = space();
    			h4 = element("h4");
    			t1 = text(t1_value);
    			t2 = space();
    			p = element("p");
    			t3 = text(t3_value);
    			t4 = space();
    			if (img.src !== (img_src_value = /*list*/ ctx[4].URL)) attr(img, "src", img_src_value);
    			attr(img, "alt", /*list*/ ctx[4].LABEL);
    			attr(img, "class", "service-img svelte-112fwe7");
    			attr(h4, "class", "svelte-112fwe7");
    			attr(div, "class", "col-md-4 service svelte-112fwe7");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, img);
    			append(div, t0);
    			append(div, h4);
    			append(h4, t1);
    			append(div, t2);
    			append(div, p);
    			append(p, t3);
    			append(div, t4);
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    function create_fragment$5(ctx) {
    	let section;
    	let div1;
    	let h2;
    	let t1;
    	let div0;
    	let t2;
    	let buttom;
    	let each_value = /*SERVICE_LIST*/ ctx[2];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$3(get_each_context$3(ctx, each_value, i));
    	}

    	return {
    		c() {
    			section = element("section");
    			div1 = element("div");
    			h2 = element("h2");
    			h2.textContent = `${/*HEADING*/ ctx[0]}`;
    			t1 = space();
    			div0 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t2 = space();
    			buttom = element("buttom");
    			buttom.textContent = `${/*ALL_SERVICES*/ ctx[1]}`;
    			attr(h2, "class", "title svelte-112fwe7");
    			attr(div0, "class", "row section-body");
    			attr(buttom, "class", "btn btn-primary round-border main-bgcolor svelte-112fwe7");
    			attr(div1, "class", "container text-center");
    			attr(section, "id", "services");
    			attr(section, "class", "section svelte-112fwe7");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, div1);
    			append(div1, h2);
    			append(div1, t1);
    			append(div1, div0);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div0, null);
    			}

    			append(div1, t2);
    			append(div1, buttom);
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*SERVICE_LIST*/ 4) {
    				each_value = /*SERVICE_LIST*/ ctx[2];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$3(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$3(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div0, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$4($$self, $$props, $$invalidate) {
    	let { serviceData = {} } = $$props;
    	const { HEADING, ALL_SERVICES, SERVICE_LIST } = serviceData;

    	$$self.$$set = $$props => {
    		if ("serviceData" in $$props) $$invalidate(3, serviceData = $$props.serviceData);
    	};

    	return [HEADING, ALL_SERVICES, SERVICE_LIST, serviceData];
    }

    class Services extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$4, create_fragment$5, safe_not_equal, { serviceData: 3 });
    	}
    }

    /* src\Components\About\About.svelte generated by Svelte v3.37.0 */

    function get_each_context$2(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[5] = list[i];
    	return child_ctx;
    }

    // (17:12) {#each WHY_CHOOSE_US_LIST as list}
    function create_each_block$2(ctx) {
    	let li;
    	let t_value = /*list*/ ctx[5] + "";
    	let t;

    	return {
    		c() {
    			li = element("li");
    			t = text(t_value);
    			attr(li, "class", "svelte-1yjig2a");
    		},
    		m(target, anchor) {
    			insert(target, li, anchor);
    			append(li, t);
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(li);
    		}
    	};
    }

    function create_fragment$4(ctx) {
    	let section;
    	let div3;
    	let h2;
    	let t1;
    	let div2;
    	let div0;
    	let h3;
    	let t3;
    	let ul;
    	let t4;
    	let div1;
    	let img;
    	let img_src_value;
    	let each_value = /*WHY_CHOOSE_US_LIST*/ ctx[3];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
    	}

    	return {
    		c() {
    			section = element("section");
    			div3 = element("div");
    			h2 = element("h2");
    			h2.textContent = `${/*HEADING*/ ctx[0]}`;
    			t1 = space();
    			div2 = element("div");
    			div0 = element("div");
    			h3 = element("h3");
    			h3.textContent = `${/*TITLE*/ ctx[1]}`;
    			t3 = space();
    			ul = element("ul");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t4 = space();
    			div1 = element("div");
    			img = element("img");
    			attr(h2, "class", "title text-center");
    			attr(h3, "class", "about-title svelte-1yjig2a");
    			attr(ul, "class", "svelte-1yjig2a");
    			attr(div0, "class", "col-md-6");
    			if (img.src !== (img_src_value = /*IMAGE_URL*/ ctx[2])) attr(img, "src", img_src_value);
    			attr(img, "alt", "");
    			attr(img, "class", "img-fluid");
    			attr(div1, "class", "col-md-6");
    			attr(div2, "class", "row section-body");
    			attr(div3, "class", "container");
    			attr(section, "id", "about-us");
    			attr(section, "class", "section grey-bgcolor svelte-1yjig2a");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, div3);
    			append(div3, h2);
    			append(div3, t1);
    			append(div3, div2);
    			append(div2, div0);
    			append(div0, h3);
    			append(div0, t3);
    			append(div0, ul);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(ul, null);
    			}

    			append(div2, t4);
    			append(div2, div1);
    			append(div1, img);
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*WHY_CHOOSE_US_LIST*/ 8) {
    				each_value = /*WHY_CHOOSE_US_LIST*/ ctx[3];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$2(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$2(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(ul, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$3($$self, $$props, $$invalidate) {
    	let { aboutData = {} } = $$props;
    	const { HEADING, TITLE, IMAGE_URL, WHY_CHOOSE_US_LIST } = aboutData;

    	$$self.$$set = $$props => {
    		if ("aboutData" in $$props) $$invalidate(4, aboutData = $$props.aboutData);
    	};

    	return [HEADING, TITLE, IMAGE_URL, WHY_CHOOSE_US_LIST, aboutData];
    }

    class About extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$3, create_fragment$4, safe_not_equal, { aboutData: 4 });
    	}
    }

    /* src\Components\Testimonials\Testimonials.svelte generated by Svelte v3.37.0 */

    function get_each_context$1(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[3] = list[i];
    	return child_ctx;
    }

    // (15:8) {#each TESTIMONIAL_LIST as list}
    function create_each_block$1(ctx) {
    	let div;
    	let p0;
    	let t0_value = /*list*/ ctx[3].DESCRIPTION + "";
    	let t0;
    	let t1;
    	let img;
    	let img_src_value;
    	let t2;
    	let p1;
    	let b;
    	let t3_value = /*list*/ ctx[3].NAME + "";
    	let t3;
    	let t4;
    	let br;
    	let t5;
    	let t6_value = /*list*/ ctx[3].DESIGNATION + "";
    	let t6;
    	let t7;

    	return {
    		c() {
    			div = element("div");
    			p0 = element("p");
    			t0 = text(t0_value);
    			t1 = space();
    			img = element("img");
    			t2 = space();
    			p1 = element("p");
    			b = element("b");
    			t3 = text(t3_value);
    			t4 = space();
    			br = element("br");
    			t5 = space();
    			t6 = text(t6_value);
    			t7 = space();
    			if (img.src !== (img_src_value = /*list*/ ctx[3].IMAGE_URL)) attr(img, "src", img_src_value);
    			attr(img, "alt", "");
    			attr(img, "class", "svelte-1pb5u1c");
    			attr(p1, "class", "user-details svelte-1pb5u1c");
    			attr(div, "class", "col-md-5 testimonial svelte-1pb5u1c");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, p0);
    			append(p0, t0);
    			append(div, t1);
    			append(div, img);
    			append(div, t2);
    			append(div, p1);
    			append(p1, b);
    			append(b, t3);
    			append(p1, t4);
    			append(p1, br);
    			append(p1, t5);
    			append(p1, t6);
    			append(div, t7);
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    function create_fragment$3(ctx) {
    	let section;
    	let div1;
    	let h2;
    	let t1;
    	let div0;
    	let each_value = /*TESTIMONIAL_LIST*/ ctx[1];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$1(get_each_context$1(ctx, each_value, i));
    	}

    	return {
    		c() {
    			section = element("section");
    			div1 = element("div");
    			h2 = element("h2");
    			h2.textContent = `${/*HEADING*/ ctx[0]}`;
    			t1 = space();
    			div0 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr(h2, "class", "title text-center");
    			attr(div0, "class", "row offset-1 section-body");
    			attr(div1, "class", "container");
    			attr(section, "id", "testimonials");
    			attr(section, "class", "section");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, div1);
    			append(div1, h2);
    			append(div1, t1);
    			append(div1, div0);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div0, null);
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*TESTIMONIAL_LIST*/ 2) {
    				each_value = /*TESTIMONIAL_LIST*/ ctx[1];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$1(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$1(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div0, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$2($$self, $$props, $$invalidate) {
    	let { testimonialData = {} } = $$props;
    	const { HEADING, TESTIMONIAL_LIST } = testimonialData;

    	$$self.$$set = $$props => {
    		if ("testimonialData" in $$props) $$invalidate(2, testimonialData = $$props.testimonialData);
    	};

    	return [HEADING, TESTIMONIAL_LIST, testimonialData];
    }

    class Testimonials extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$2, create_fragment$3, safe_not_equal, { testimonialData: 2 });
    	}
    }

    /* src\Components\Social\Social.svelte generated by Svelte v3.37.0 */

    function get_each_context(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[3] = list[i];
    	return child_ctx;
    }

    // (14:8) {#each IMAGES_LIST as list}
    function create_each_block(ctx) {
    	let a;
    	let img;
    	let img_src_value;
    	let t;

    	return {
    		c() {
    			a = element("a");
    			img = element("img");
    			t = space();
    			if (img.src !== (img_src_value = /*list*/ ctx[3])) attr(img, "src", img_src_value);
    			attr(img, "alt", "Social media " + /*list*/ ctx[3]);
    			attr(img, "class", "svelte-tn4q0m");
    			attr(a, "href", "https://www.linkedin.com/in/nikhil-karkra-73a15319/");
    			attr(a, "target", "_blank");
    			attr(a, "class", "svelte-tn4q0m");
    		},
    		m(target, anchor) {
    			insert(target, a, anchor);
    			append(a, img);
    			append(a, t);
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(a);
    		}
    	};
    }

    function create_fragment$2(ctx) {
    	let section;
    	let div1;
    	let h2;
    	let t1;
    	let div0;
    	let each_value = /*IMAGES_LIST*/ ctx[0];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
    	}

    	return {
    		c() {
    			section = element("section");
    			div1 = element("div");
    			h2 = element("h2");
    			h2.textContent = `${/*HEADING*/ ctx[1]}`;
    			t1 = space();
    			div0 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr(h2, "class", "title text-center");
    			attr(div0, "class", "social-icons section-body svelte-tn4q0m");
    			attr(div1, "class", "container text-center");
    			attr(section, "id", "social-media");
    			attr(section, "class", "section grey-bgcolor");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, div1);
    			append(div1, h2);
    			append(div1, t1);
    			append(div1, div0);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div0, null);
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*IMAGES_LIST*/ 1) {
    				each_value = /*IMAGES_LIST*/ ctx[0];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div0, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$1($$self, $$props, $$invalidate) {
    	let { socialData = {} } = $$props;
    	const { IMAGES_LIST, HEADING } = socialData;

    	$$self.$$set = $$props => {
    		if ("socialData" in $$props) $$invalidate(2, socialData = $$props.socialData);
    	};

    	return [IMAGES_LIST, HEADING, socialData];
    }

    class Social extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$1, create_fragment$2, safe_not_equal, { socialData: 2 });
    	}
    }

    /* src\Components\Footer\Footer.svelte generated by Svelte v3.37.0 */

    function create_fragment$1(ctx) {
    	let section;
    	let img;
    	let img_src_value;
    	let t0;
    	let div5;
    	let div4;
    	let div1;
    	let div0;
    	let t1;
    	let t2;
    	let p0;
    	let t4;
    	let div2;
    	let p1;
    	let t6;
    	let p2;
    	let i0;
    	let t7;
    	let t8;
    	let t9;
    	let p3;
    	let i1;
    	let t10;
    	let t11;
    	let t12;
    	let p4;
    	let i2;
    	let t13;
    	let t14;
    	let t15;
    	let div3;
    	let p5;
    	let t17;
    	let input;
    	let t18;
    	let button;

    	return {
    		c() {
    			section = element("section");
    			img = element("img");
    			t0 = space();
    			div5 = element("div");
    			div4 = element("div");
    			div1 = element("div");
    			div0 = element("div");
    			t1 = text(/*header*/ ctx[0]);
    			t2 = space();
    			p0 = element("p");
    			p0.textContent = `${/*DESCRIPTION*/ ctx[1]}`;
    			t4 = space();
    			div2 = element("div");
    			p1 = element("p");
    			p1.textContent = `${/*HEADING*/ ctx[4]}`;
    			t6 = space();
    			p2 = element("p");
    			i0 = element("i");
    			t7 = space();
    			t8 = text(/*ADDRESS*/ ctx[5]);
    			t9 = space();
    			p3 = element("p");
    			i1 = element("i");
    			t10 = space();
    			t11 = text(/*MOBILE*/ ctx[6]);
    			t12 = space();
    			p4 = element("p");
    			i2 = element("i");
    			t13 = space();
    			t14 = text(/*EMAIL*/ ctx[7]);
    			t15 = space();
    			div3 = element("div");
    			p5 = element("p");
    			p5.textContent = `${/*SUBSCRIBE_NEWSLETTER*/ ctx[2]}`;
    			t17 = space();
    			input = element("input");
    			t18 = space();
    			button = element("button");
    			button.textContent = `${/*SUBSCRIBE*/ ctx[3]}`;
    			if (img.src !== (img_src_value = "images/wave2.png")) attr(img, "src", img_src_value);
    			attr(img, "alt", "");
    			attr(img, "class", "wave-img svelte-h6xxja");
    			attr(div0, "class", "company_brand");
    			attr(div1, "class", "col-md-4 footer-box");
    			attr(p1, "class", "footer-title svelte-h6xxja");
    			attr(i0, "class", "fas fa-map-marker-alt");
    			attr(i1, "class", "fas fa-phone");
    			attr(i2, "class", "fas fa-envelope");
    			attr(div2, "class", "col-md-4 footer-box");
    			attr(p5, "class", "footer-title svelte-h6xxja");
    			attr(input, "type", "email");
    			attr(input, "class", "form-control round-border svelte-h6xxja");
    			attr(input, "placeholder", "Your Email");
    			attr(button, "type", "button");
    			attr(button, "class", "btn btn-outline-light round-border svelte-h6xxja");
    			attr(div3, "class", "col-md-4 footer-box svelte-h6xxja");
    			attr(div4, "class", "row section-body");
    			attr(div5, "class", "container");
    			attr(section, "class", "main-bgcolor light-color");
    			attr(section, "id", "footer");
    		},
    		m(target, anchor) {
    			insert(target, section, anchor);
    			append(section, img);
    			append(section, t0);
    			append(section, div5);
    			append(div5, div4);
    			append(div4, div1);
    			append(div1, div0);
    			append(div0, t1);
    			append(div1, t2);
    			append(div1, p0);
    			append(div4, t4);
    			append(div4, div2);
    			append(div2, p1);
    			append(div2, t6);
    			append(div2, p2);
    			append(p2, i0);
    			append(p2, t7);
    			append(p2, t8);
    			append(div2, t9);
    			append(div2, p3);
    			append(p3, i1);
    			append(p3, t10);
    			append(p3, t11);
    			append(div2, t12);
    			append(div2, p4);
    			append(p4, i2);
    			append(p4, t13);
    			append(p4, t14);
    			append(div4, t15);
    			append(div4, div3);
    			append(div3, p5);
    			append(div3, t17);
    			append(div3, input);
    			append(div3, t18);
    			append(div3, button);
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*header*/ 1) set_data(t1, /*header*/ ctx[0]);
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(section);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let { footerData = {} } = $$props;
    	let { header = "" } = $$props;
    	const { DESCRIPTION, CONTACT_DETAILS, SUBSCRIBE_NEWSLETTER, SUBSCRIBE } = footerData;
    	const { HEADING, ADDRESS, MOBILE, EMAIL } = CONTACT_DETAILS;

    	$$self.$$set = $$props => {
    		if ("footerData" in $$props) $$invalidate(8, footerData = $$props.footerData);
    		if ("header" in $$props) $$invalidate(0, header = $$props.header);
    	};

    	return [
    		header,
    		DESCRIPTION,
    		SUBSCRIBE_NEWSLETTER,
    		SUBSCRIBE,
    		HEADING,
    		ADDRESS,
    		MOBILE,
    		EMAIL,
    		footerData
    	];
    }

    class Footer extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance, create_fragment$1, safe_not_equal, { footerData: 8, header: 0 });
    	}
    }

    /**src/Data/data.js**/
    const HEADER = "Nixalar";

    const NAVBAR_DATA = [
      { id: 1, url: "/", label: "Home" },
      { id: 2, url: "#services", label: "Services" },
      { id: 3, url: "#about-us", label: "About us" },
      { id: 4, url: "#testimonials", label: "Testimonials" },
      { id: 5, url: "#footer", label: "Contacts" }
    ];
    const BANNER_DATA = {
      HEADING: "Go digital with nixalar",
      DECRIPTION:
        "Nixalar can help you skyrocket the ROI of your marketing campaign without having to spend tons of money or time to assemble an in-house team.",
      TUTORIAL_URL:
        "https://www.thinkwithgoogle.com/intl/en-gb/marketing-resources/programmatic/google-digital-academy/",
      WATCH_TUTORIAL: "Watch Tutorials"
    };
    const SERVICE_DATA = {
      HEADING: "Our Services",
      ALL_SERVICES: "All Services",
      SERVICE_LIST: [
        {
          LABEL: "Search Engine Optimisation",
          DESCRIPTION:
            "To customise the content, technical functionality and scope of your website so that your pages show for a specific set of keyword at the top of a search engine list. In the end, the goal is to attract traffic to your website when they are searching for goods, services or business-related information.",
          URL: "images/service1.png"
        },
        {
          LABEL: "Content Marketing Strategy",
          DESCRIPTION:
            "It is tough but well worth the effort to create clever material that is not promotional in nature, but rather educates and inspires. It lets them see you as a reliable source of information by delivering content that is meaningful to your audience.",
          URL: "images/service2.png"
        },
        {
          LABEL: "Develop Social Media Strategy",
          DESCRIPTION:
            "Many People rely on social networks to discover, research, and educate themselves about a brand before engaging with that organization. The more your audience wants to engage with your content, the more likely it is that they will want to share it.",
          URL: "images/service3.png"
        }
      ]
    };

    const ABOUT_DATA = {
      HEADING: "Why choose us?",
      TITLE: "Why we're different",
      IMAGE_URL: "images/network.png",
      WHY_CHOOSE_US_LIST: [
        "We provides Cost-Effective Digital Marketing than Others.",
        "High customer statisfaction and experience.",
        "Marketing efficiency and quick time to value.",
        "Clear & transparent fee structure.",
        "We provides Marketing automation which is an integral platform that ties all of your digital marketing together.",
        "A strong desire to establish long lasting business partnerships.",
        "Provide digital marketing to mobile consumer.",
        "We provides wide range to services in reasonable prices"
      ]
    };
    const TESTIMONIAL_DATA = {
      HEADING: "What clients say?",
      TESTIMONIAL_LIST: [
        {
          DESCRIPTION:
            "Nixalar has made a huge difference to our business with his good work and knowledge of SEO and business to business marketing techniques. Our search engine rankings are better than ever and we are getting more people contacting us thanks to Jomer’s knowledge and hard work.",
          IMAGE_URL: "images/user1.jpg",
          NAME: "Julia hawkins",
          DESIGNATION: "Co-founder at ABC"
        },
        {
          DESCRIPTION:
            "Nixalar and his team have provided us with a comprehensive, fast and well planned digital marketing strategy that has yielded great results in terms of content, SEO, Social Media. His team are a pleasure to work with, as well as being fast to respond and adapt to the needs of your brand.",
          IMAGE_URL: "images/user2.jpg",
          NAME: "John Smith",
          DESIGNATION: "Co-founder at xyz"
        }
      ]
    };

    const SOCIAL_DATA = {
      HEADING: "Find us on social media",
      IMAGES_LIST: [
        "images/facebook-icon.png",
        "images/instagram-icon.png",
        "images/whatsapp-icon.png",
        "images/twitter-icon.png",
        "images/linkedin-icon.png",
        "images/snapchat-icon.png"
      ]
    };

    const FOOTER_DATA = {
      DESCRIPTION:
        "We are typically focused on result-based maketing in the digital world. Also, we evaluate your brand’s needs and develop a powerful strategy that maximizes profits.",
      CONTACT_DETAILS: {
        HEADING: "Contact us",
        ADDRESS: "La trobe street docklands, Melbourne",
        MOBILE: "+1 61234567890",
        EMAIL: "nixalar@gmail.com"
      },
      SUBSCRIBE_NEWSLETTER: "Subscribe newsletter",
      SUBSCRIBE: "Subscribe"
    };

    const MOCK_DATA = {
      HEADER,
      NAVBAR_DATA,
      BANNER_DATA,
      SERVICE_DATA,
      ABOUT_DATA,
      TESTIMONIAL_DATA,
      SOCIAL_DATA,
      FOOTER_DATA
    };

    /* src\App.svelte generated by Svelte v3.37.0 */

    function create_fragment(ctx) {
    	let navbar;
    	let t0;
    	let banner;
    	let t1;
    	let services;
    	let t2;
    	let about;
    	let t3;
    	let testimonials;
    	let t4;
    	let social;
    	let t5;
    	let footer;
    	let current;

    	navbar = new Navbar({
    			props: {
    				navlists: MOCK_DATA.NAVBAR_DATA,
    				header: MOCK_DATA.HEADER
    			}
    		});

    	banner = new Banner({ props: { bannerData: MOCK_DATA.BANNER_DATA } });

    	services = new Services({
    			props: { serviceData: MOCK_DATA.SERVICE_DATA }
    		});

    	about = new About({ props: { aboutData: MOCK_DATA.ABOUT_DATA } });

    	testimonials = new Testimonials({
    			props: { testimonialData: MOCK_DATA.TESTIMONIAL_DATA }
    		});

    	social = new Social({ props: { socialData: MOCK_DATA.SOCIAL_DATA } });

    	footer = new Footer({
    			props: {
    				footerData: MOCK_DATA.FOOTER_DATA,
    				header: MOCK_DATA.HEADER
    			}
    		});

    	return {
    		c() {
    			create_component(navbar.$$.fragment);
    			t0 = space();
    			create_component(banner.$$.fragment);
    			t1 = space();
    			create_component(services.$$.fragment);
    			t2 = space();
    			create_component(about.$$.fragment);
    			t3 = space();
    			create_component(testimonials.$$.fragment);
    			t4 = space();
    			create_component(social.$$.fragment);
    			t5 = space();
    			create_component(footer.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(navbar, target, anchor);
    			insert(target, t0, anchor);
    			mount_component(banner, target, anchor);
    			insert(target, t1, anchor);
    			mount_component(services, target, anchor);
    			insert(target, t2, anchor);
    			mount_component(about, target, anchor);
    			insert(target, t3, anchor);
    			mount_component(testimonials, target, anchor);
    			insert(target, t4, anchor);
    			mount_component(social, target, anchor);
    			insert(target, t5, anchor);
    			mount_component(footer, target, anchor);
    			current = true;
    		},
    		p: noop,
    		i(local) {
    			if (current) return;
    			transition_in(navbar.$$.fragment, local);
    			transition_in(banner.$$.fragment, local);
    			transition_in(services.$$.fragment, local);
    			transition_in(about.$$.fragment, local);
    			transition_in(testimonials.$$.fragment, local);
    			transition_in(social.$$.fragment, local);
    			transition_in(footer.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(navbar.$$.fragment, local);
    			transition_out(banner.$$.fragment, local);
    			transition_out(services.$$.fragment, local);
    			transition_out(about.$$.fragment, local);
    			transition_out(testimonials.$$.fragment, local);
    			transition_out(social.$$.fragment, local);
    			transition_out(footer.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(navbar, detaching);
    			if (detaching) detach(t0);
    			destroy_component(banner, detaching);
    			if (detaching) detach(t1);
    			destroy_component(services, detaching);
    			if (detaching) detach(t2);
    			destroy_component(about, detaching);
    			if (detaching) detach(t3);
    			destroy_component(testimonials, detaching);
    			if (detaching) detach(t4);
    			destroy_component(social, detaching);
    			if (detaching) detach(t5);
    			destroy_component(footer, detaching);
    		}
    	};
    }

    class App extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, null, create_fragment, safe_not_equal, {});
    	}
    }

    const app = new App({
    	target: document.body,
    	props: {
    		name: 'world'
    	}
    });

    return app;

}());
//# sourceMappingURL=bundle.js.map
