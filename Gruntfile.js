var child_process = require('child_process');
var util = require('util');

module.exports = function(grunt) {
  'use strict';

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    compile: {
        curve25519: {
            src_files: [
              'native/ed25519/additions/*.c',
              'native/curve25519-donna.c',
              'native/ed25519/*.c',
              'native/ed25519/sha512/sha2big.c'
            ],
            methods: [
              'curve25519_donna',
              'curve25519_sign',
              'curve25519_verify',
              'crypto_sign_ed25519_ref10_ge_scalarmult_base',
              'sph_sha512_init',
              'malloc'
            ]
        }
    }
  });

  grunt.registerMultiTask('compile', 'Compile the C libraries with emscripten.', function() {
      var callback = this.async();
      var outfile = 'build/' + this.target + '.js';

      var exported_functions = this.data.methods.map(function(name) {
        return "'_" + name + "'";
      });
      var flags = [
          '-O3',
          '--memory-init-file 0',
          '-Qunused-arguments',
          '-s INLINING_LIMIT=1',
          '-s WASM=0',
          '--minify 0',
          '-o',  outfile,
          '-Inative/ed25519/nacl_includes -Inative/ed25519 -Inative/ed25519/sha512',
          '-s', "EXPORTED_FUNCTIONS=\"[" + exported_functions.join(',') + "]\""];
      var command = [].concat('emcc', this.data.src_files, flags).join(' ');
      grunt.log.writeln('Compiling via emscripten to ' + outfile);

      var exitCode = 0;
      grunt.verbose.subhead(command);
      grunt.verbose.writeln(util.format('Expecting exit code %d', exitCode));

      var child = child_process.exec(command);
      child.stdout.on('data', function (d) { grunt.log.write(d); });
      child.stderr.on('data', function (d) { grunt.log.error(d); });
      child.on('exit', function(code) {
        if (code !== exitCode) {
          grunt.log.error(util.format('Exited with code: %d.', code));
          return callback(false);
        }

        grunt.verbose.ok(util.format('Exited with code: %d.', code));
        callback(true);
      });
  });

  grunt.registerTask('default', ['compile']);
  grunt.registerTask('build', ['compile']);
};
