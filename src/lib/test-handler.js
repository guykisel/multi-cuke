import _ from 'lodash';
import Promise from 'bluebird';
import fs from 'fs-extra';
import path from 'path';
import OutputHandler from './parsers/pretty';
import featureFinder from './feature-finder';
import VerboseLogger from '../utils/verbose-logger';
import Worker from './worker';

export default class TestHandler {
  constructor(options) {
    this.outputHandler = new OutputHandler();
    this.silentSummary = options.silentSummary;
    this.failFast = options.failFast;
    this.verboseLogger = new VerboseLogger(options.verbose);
    this.workers = [];
    this.scenarios = [];
    this.options = options;
    this.overallExitCode = 0;
    this.summaryData = {};
    this.mergedLog = options.mergedLog;
    this.disableMergedLog = options.disableMergedLog;
  }

  run() {
    this.verboseLogger.log('Beginning test run with the following options:');
    this.verboseLogger.log(this.options);

    return this.runTestSuite()
      .then(() => {
        return this.waitForChildren();
      })
      .then(() => {
        if (!this.disableMergedLog) {
          this.mergeLogs();
        }
        return {
          exitCode: this.overallExitCode,
          outputHandler: this.outputHandler
        };
      });
  }

  runTestSuite() {
    return featureFinder(this.options).then((result) => {
      if (result.didDetectErrors) {
        this.overallExitCode = 1;
      }

      let scenarios = result.scenarios;
      if (_.isEmpty(scenarios)) {
        console.warn('There are no scenarios found that match the options passed.');
        this.verboseLogger.log('Options passed:\n', this.options);
        this.outputHandler.setEndTime();
      } else {
        this.verboseLogger.log('Scenarios found that match options:');
        this.verboseLogger.logScenarios(scenarios);
      }

      this.scenarios = scenarios;
      for (var i = 0; i < this.options.workers; i++) {
        if (!_.isEmpty(scenarios)) {
          this.createWorker(scenarios.shift());
        }
      }
    });
  }

  waitForChildren() {
    return Promise.delay(500)
      .then(() => {
        if (_.isEmpty(this.scenarios) && _.isEmpty(this.workers)) {
          return this.outputHandler.scenarioStatuses.failed.length;
        } else {
          return this.waitForChildren();
        }
      });
  }

  mergeLogs() {
    let testResults = [];
    let logFilePaths = fs.readdirSync(this.options.logDir);
    logFilePaths.forEach((logFilePath) => {
      try {
        if (_.endsWith(logFilePath, '.json')) {
          let log = fs.readJsonSync(path.join(this.options.logDir, logFilePath), 'utf8')[0];
          let existingLog = _.find(testResults, testResult => {
            return testResult.name === log.name && testResult.line === log.line;
          });

          if (existingLog) {
            existingLog.elements.push(log.elements[0]);
          } else {
            testResults = _.concat(testResults, [log]);
          }
        }
      } catch (e) {
        // ignore errors from invalid/empty files
      }
    });
    fs.ensureDirSync(path.dirname(this.mergedLog));
    fs.writeJsonSync(this.mergedLog, testResults);
  }

  createWorker(scenario) {
    this.verboseLogger.log('Initializing worker for: ' + scenario.featureFile + ':' + scenario.scenarioLine);
    let testOptions = {
      featureFile: scenario.featureFile,
      scenarioLine: scenario.scenarioLine,
      isScenarioOutline: scenario.isScenarioOutline,
      logDir: this.options.logDir,
      cucumberPath: this.options.cucumberPath.replace('lib', 'bin'),
      requires: this.options.requires,
      scenario: scenario,
      inlineStream: this.options.inlineStream,
      strict: this.options.strict,
      workerEnvVars: this.options.workerEnvVars
    };

    let worker = new Worker(testOptions);

    let done = (payload) => {
      let output = this.outputHandler.handleResult(payload);
      console.log(output);

      if (payload.exitCode !== 0) {
        this.overallExitCode = 1;
        if (this.failFast) {
          this.verboseLogger.log('Fail fast: A scenario failed, clearing remaining scenarios.');
          this.scenarios = [];
        }
      }

      _.pull(this.workers, worker);
      this.verboseLogger.log('Scenarios in progress:');
      this.verboseLogger.logScenarios(_.map(this.workers, 'scenario'));

      if (!_.isEmpty(this.scenarios)) {
        this.createWorker(this.scenarios.shift());
      }

      if (_.isEmpty(this.scenarios) && _.isEmpty(this.workers)) {
        this.outputHandler.setEndTime();

        if (!this.silentSummary) {
          console.log(this.outputHandler.getSummaryOutput());
        }
      }
    };

    this.workers.push(worker);

    return worker.execute()
      .then((result) => {
        return done(result);
      })
      .catch((err) => {
        console.log(err.stack);
      });
  }

  kill() {
    this.workers.forEach((worker) => {
      worker.kill();
    });
  }
}
