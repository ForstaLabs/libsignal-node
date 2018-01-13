 /*
  * jobQueue manages multiple queues indexed by device to serialize
  * session io ops on the database.
  */
'use strict';


const jobQueue = {};

const SessionLock = {
    queueJob: function(ident, runJob) {
        const runPrevious = jobQueue[ident] || Promise.resolve();
        const runCurrent = jobQueue[ident] = runPrevious.then(runJob, runJob);
        runCurrent.then(() => {
            if (jobQueue[ident] === runCurrent) {
                delete jobQueue[ident];
            }
        });
        return runCurrent;
    }
};

module.exports = SessionLock;
