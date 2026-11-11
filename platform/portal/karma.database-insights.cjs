module.exports = config => config.set({
  frameworks: ['jasmine', '@angular-devkit/build-angular'],
  plugins: [require('karma-jasmine'), require('karma-chrome-launcher'), require('@angular-devkit/build-angular/plugins/karma')],
  reporters: ['progress'],
  customLaunchers: { LocalHeadless: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--disable-gpu', '--in-process-gpu'] } },
  browsers: ['LocalHeadless'], singleRun: true
});
