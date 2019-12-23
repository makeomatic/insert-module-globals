const undeclaredIdentifiers = require('undeclared-identifiers');
const through = require('through2');
const parse = require('acorn-node').parse;

const path = require('path');
const { isAbsolute } = path;
const processPath = require.resolve('process/browser.js');
const isbufferPath = require.resolve('is-buffer')
const combineSourceMap = require('@makeomatic/combine-source-map');

function getRelativeRequirePath(fullPath, fromPath) {
  let relpath = path.relative(path.dirname(fromPath), fullPath);
  // If fullPath is in the same directory or a subdirectory of fromPath,
  // relpath will result in something like "index.js", "src/abc.js".
  // require() needs "./" prepended to these paths.
  if (!/^\./.test(relpath) && !isAbsolute(relpath)) {
    relpath = "./" + relpath;
  }
  // On Windows: Convert path separators to what require() expects
  if (path.sep === '\\') {
    relpath = relpath.replace(/\\/g, '/');
  }
  return relpath;
}

const defaultVars = {
    process: function (file) {
        const relpath = getRelativeRequirePath(processPath, file);
        return 'require(' + JSON.stringify(relpath) + ')';
    },
    global: function () {
        return 'typeof global !== "undefined" ? global : '
            + 'typeof self !== "undefined" ? self : '
            + 'typeof window !== "undefined" ? window : {}'
        ;
    },
    'Buffer.isBuffer': function (file) {
        const relpath = getRelativeRequirePath(isbufferPath, file);
        return 'require(' + JSON.stringify(relpath) + ')';
    },
    Buffer: function () {
        return 'require("buffer").Buffer';
    },
    setImmediate: function () {
        return 'require("timers").setImmediate';
    },
    clearImmediate: function () {
        return 'require("timers").clearImmediate';
    },
    __filename: function (file, basedir) {
        let relpath = path.relative(basedir, file);
        // standardize path separators, use slash in Windows too
        if ( path.sep === '\\' ) {
          relpath = relpath.replace(/\\/g, '/');
        }
        const filename = '/' + relpath;
        return JSON.stringify(filename);
    },
    __dirname: function (file, basedir) {
        let relpath = path.relative(basedir, file);
        // standardize path separators, use slash in Windows too
        if ( path.sep === '\\' ) {
          relpath = relpath.replace(/\\/g, '/');
        }
        const dir = path.dirname('/' + relpath );
        return JSON.stringify(dir);
    }
};

module.exports = function (file, opts) {
    if (/\.json$/i.test(file)) return through();
    if (!opts) opts = {};

    const basedir = opts.basedir || '/';
    const vars = Object.assign({}, defaultVars, opts.vars);
    const varNames = Object.keys(vars).filter(function(name) {
        return typeof vars[name] === 'function';
    });

    const quick = RegExp(varNames.map(function (name) {
        return '\\b' + name + '\\b';
    }).join('|'));

    const chunks = [];

    return through(write, end);

    function write (chunk, enc, next) { chunks.push(chunk); next() }

    async function end () {
        const self = this;
        let source = Buffer.isBuffer(chunks[0])
            ? Buffer.concat(chunks).toString('utf8')
            : chunks.join('')
        ;
        source = source
            .replace(/^\ufeff/, '')
            .replace(/^#![^\n]*\n/, '\n');

        if (opts.always !== true && !quick.test(source)) {
            this.push(source);
            this.push(null);
            return;
        }

        let undeclared;
        try {
            undeclared = opts.always
                ? { identifiers: varNames, properties: [] }
                : undeclaredIdentifiers(parse(source), { wildcard: true })
            ;
        }
        catch (err) {
            const e = new SyntaxError(
                (err.message || err) + ' while parsing ' + file
            );
            e.type = 'syntax';
            e.filename = file;
            return this.emit('error', e);
        }

        const globals = {};

        varNames.forEach(function (name) {
            if (!/\./.test(name)) return;
            const parts = name.split('.')
            const prop = undeclared.properties.indexOf(name)
            if (prop === -1 || countprops(undeclared.properties, parts[0]) > 1) return;
            const value = vars[name](file, basedir);
            if (!value) return;
            globals[parts[0]] = '{'
                + JSON.stringify(parts[1]) + ':' + value + '}';
            self.emit('global', name);
        });
        varNames.forEach(function (name) {
            if (/\./.test(name)) return;
            if (globals[name]) return;
            if (undeclared.identifiers.indexOf(name) < 0) return;
            const value = vars[name](file, basedir);
            if (!value) return;
            globals[name] = value;
            self.emit('global', name);
        });

        try {
          this.push(await closeOver(globals, source, file, opts));
        } catch (e) {
          return this.emit('error', e);
        }

        this.push(null);
    }
};

module.exports.vars = defaultVars;

async function closeOver (globals, src, file, opts) {
    const keys = Object.keys(globals);
    if (keys.length === 0) return src;
    const values = keys.map(function (key) { return globals[key] });

    let wrappedSource;
    if (keys.length <= 3) {
        wrappedSource = '(function (' + keys.join(',') + '){\n'
            + src + '\n}).call(this,' + values.join(',') + ')'
        ;
    }
    else {
      // necessary to make arguments[3..6] still work for workerify etc
      // a,b,c,arguments[3..6],d,e,f...
      const extra = [ '__argument0', '__argument1', '__argument2', '__argument3' ];
      const names = keys.slice(0,3).concat(extra).concat(keys.slice(3));
      values.splice(3, 0,
          'arguments[3]','arguments[4]',
          'arguments[5]','arguments[6]'
      );
      wrappedSource = '(function (' + names.join(',') + '){\n'
        + src + '\n}).call(this,' + values.join(',') + ')';
    }

    // Generate source maps if wanted. Including the right offset for
    // the wrapped source.
    if (!opts.debug) {
        return wrappedSource;
    }
    const sourceFile = path.relative(opts.basedir, file)
        .replace(/\\/g, '/');
    const sourceMap = combineSourceMap.create();
    await sourceMap.addFile({ sourceFile: sourceFile, source: src }, { line: 1 });
    return combineSourceMap.removeComments(wrappedSource) + "\n"
        + sourceMap.comment();
}

function countprops (props, name) {
    return props.filter(function (prop) {
        return prop.slice(0, name.length + 1) === name + '.';
    }).length;
}
