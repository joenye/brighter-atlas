// Browser globals referenced inside page.evaluate()/$eval() callbacks in the
// puppeteer tools. Those callbacks execute in Chrome, not in Node: the tools
// tsconfig deliberately omits the DOM lib (this is a Node project), so the
// handful of browser globals the callbacks touch are declared loosely here.
declare var document: any;
declare var window: any;
declare var location: any;
declare var localStorage: any;
declare var indexedDB: any;
declare var caches: any;
declare var KeyboardEvent: any;
declare function getComputedStyle(elt: any): any;
declare function requestAnimationFrame(callback: (time: number) => void): number;
