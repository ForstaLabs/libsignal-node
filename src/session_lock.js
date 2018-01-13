 /*
  * jobQueue manages multiple queues indexed by device to serialize
  * session io ops on the database.
  */
'use strict';


const _queueAsyncBuckets = new Map();

async function _asyncQueueExecutor(queue, cleanup) {
    let offt = 0;
    const gcLimit = 100;
    while (true) {
        let limit = Math.min(queue.length, gcLimit); // Break up thundering hurds for GC duty.
        for (let i = offt; i < limit; i++) {
            const job = queue[i];
            try {
                job.resolve(await job.awaitable());
            } catch(e) {
                job.reject(e);
            }
        }
        if (limit < queue.length) {
            /* Perform lazy GC of queue for faster iteration. */
            if (limit >= gcLimit) {
                queue.splice(0, limit);
                offt = 0;
            } else {
                offt = limit;
            }
        } else {
            break;
        }
    }
    cleanup();
}

const SessionLock = {
    jobQueue: function(bucket, awaitable) {
        /* Run the async awaitable only when all other async calls registered
         * here have completed (or thrown).  The bucket argument is a hashable
         * key representing the task queue to use. */
        let inactive;
        if (!_queueAsyncBuckets.has(bucket)) {
            _queueAsyncBuckets.set(bucket, []);
            inactive = true;
        }
        const queue = _queueAsyncBuckets.get(bucket);
        const job = new Promise((resolve, reject) => queue.push({
            awaitable,
            resolve,
            reject
        }));
        if (inactive) {
            /* An executor is not currently active; Start one now. */
            _asyncQueueExecutor(queue, () => _queueAsyncBuckets.delete(bucket));
        }
        return job;
    }
};

module.exports = SessionLock;
