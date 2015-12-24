"use strict";

var colors = require('colors/safe');
var babel = require('babel-core');
var PREFIX = "[STREAMLINE-FLOW-PLUGIN] ";

function log(message) {
	// use console.error as stdout seems swallowed
	console.error(colors.gray(PREFIX + message));
}

function warn(message) {
	// use console.error as stdout seems swallowed
	console.error(colors.yellow(PREFIX + message));
}

function error(message) {
	return new Error(colors.magenta(PREFIX + message));
}

function assert(cond) {
	if (!cond) throw error("assertion failed");
}

function is_(node) {
	return node.type === 'Identifier' && node.name === '_' && !node.$done;
}

function isFutureArg(node) {
	return node.type === 'UnaryExpression' && node.operator === '!' && is_(node.argument);
}

function isPromiseArg(node) {
	return node.type === 'UnaryExpression' && node.operator === 'void' && is_(node.argument);
}

function isArray_(node) {
	return node.type === 'ArrayExpression' && node.elements.length === 1 && is_(node.elements[0]);
}

function findIndex(array, pred, start) {
	for (var i = start || 0; i < array.length; i++)
	if (pred(array[i])) return i;
	return -1;
}

function canTransform(state) {
	return /^(unknown|.*\._(js|coffee))$/.test(state.file.opts.filename);
}

var declTemplate = babel.template('var $$streamline = require("streamline-runtime").runtime;');

var functionTemplate = babel.template('{ _(null, (() => { $body$ })()) }');

function futureCall(t, scope, state, node, index1, index2, returnArray) {
	node.arguments.splice(index1, index2 == null ? 1 : 2);
	var futureFn = t.memberExpression(t.identifier('$$streamline'), t.identifier('future_' + index1 + '_' + node.arguments.length));
	var fn = t.callExpression(futureFn, [node.callee]);
	return t.callExpression(fn, node.arguments);
}

function awaitCall(t, scope, state, node, index1, index2, returnArray) {
	var awaitFn = t.memberExpression(t.identifier('$$streamline'), t.identifier('await'));
	var future = futureCall(t, scope, state, node, index1, index2, returnArray);
	return t.callExpression(awaitFn, [future]);
}

module.exports = function(pluginArguments) {
	var t = pluginArguments.types;
	return {
		visitor: {
			Program: function(path, state) {
				var node = path.node;
				if (!canTransform(state)) return;
				var decl = declTemplate();
				if (node.body[0]) {
					decl.leadingComments = node.body[0].leadingComments;
					delete node.body[0].leadingComments;
				}
				decl.leadingComments.push({
					type: 'trailing',
					value: '::declare type _<T> = (err : ?Error, result : T) => void;',
				});
				node.body.unshift(decl);
			},
			Function: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				if (!canTransform(state)) return;
				var index = findIndex(node.params, is_);
				if (index >= 0) {
					var body = node.type === 'ArrowFunctionExpression' && !t.isStatement(node.body) //
						? t.returnStatement(node.body) : node.body;
					node.body = functionTemplate({
						$body$: body
					});
				}
			},
			CallExpression: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				if (!canTransform(state)) return;
				var callee = node.callee;
				if (t.isMemberExpression(callee) && /^(forEach|map|filter|every|some|reduce|reduceRight|sort)_$/.test(callee.property.name)) {
					var arrayFn = t.memberExpression(t.identifier('$$streamline'), t.identifier('array'));
					node.callee.object = t.callExpression(arrayFn, [callee.object]);
				}
				var index1;
				var funcScope = scope.getFunctionParent();
				if ((index1 = findIndex(node.arguments, is_)) >= 0) {
					var index2 = findIndex(node.arguments, is_, index1 + 1);
					if (index2 >= 0) {
						if (findIndex(node.arguments, is_) >= 0) throw path.buildCodeFrameError("async call cannot have more than 2 _ arguments");
						path.replaceWith(awaitCall(t, scope, state, node, index1, index2, false));
					} else {
						path.replaceWith(awaitCall(t, scope, state, node, index1, null, false));
					}
				} else if ((index1 = findIndex(node.arguments, isFutureArg)) >= 0) {
					path.replaceWith(futureCall(t, scope, state, node, index1));
				} else if ((index1 = findIndex(node.arguments, isPromiseArg)) >= 0) {
					throw path.buildCodeFrameError("NIY promise arg");
					//path.replaceWith(t.memberExpression(futureCall(t, scope, state, node, index1), t.identifier('promise')));
				} else if ((index1 = findIndex(node.arguments, isArray_)) >= 0) {
					throw path.buildCodeFrameError("NIY array arg");
					//path.replaceWith(awaitCall(t, scope, state, node, index1, null, true));
				}
			},
			NewExpression: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				if (!canTransform(state)) return;
				var index = findIndex(node.arguments, is_);
				if (index >= 0) {
					throw path.buildCodeFrameError("NIY async new");
					//path.replaceWith(awaitWrap(t, state, streamlineNew(t, state, node, index)));
				}
			},
		}
	};
}