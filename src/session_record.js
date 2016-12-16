/*
 * vim: ts=4:sw=4
 */

'use strict';

const ARCHIVED_STATES_MAX_LENGTH = 40;
const BaseKeyType = require('./base_key_type.js');


const SessionRecord = (function() {
    var MESSAGE_LOST_THRESHOLD_MS = 1000*60*60*24*7;

    var SessionRecord = function(identityKey, registrationId) {
        this._sessions = {};
        if (!(identityKey instanceof Buffer)) {
            throw new TypeError('identityKey must be Buffer');
        }
        this.identityKey = identityKey;
        this.registrationId = registrationId;

        if (this.registrationId === undefined || typeof this.registrationId !== 'number') {
            this.registrationId = null;
        }
    };

    SessionRecord.deserialize = function(data) {
        data.identityKey = Buffer.from(data.identityKey, 'base64');
        for (const x of Object.keys(data.sessions)) {
            let s = data.sessions[x];
            let cr = s.currentRatchet;
            cr.rootKey = Buffer.from(cr.rootKey, 'base64');
            cr.lastRemoteEphemeralKey = Buffer.from(cr.lastRemoteEphemeralKey, 'base64');
            s.indexInfo.remoteIdentityKey = Buffer.from(s.indexInfo.remoteIdentityKey, 'base64');
        }
        var record = new SessionRecord(data.identityKey, data.registrationId);
        record._sessions = data.sessions;
        return record;
    };

    SessionRecord.prototype = {
        serialize: function() {
            const sessions = Object.keys(this._sessions).map(function(x) {
                let src = this._sessions[x];
                let dst = JSON.parse(JSON.stringify(src)); // deep copy sans-buffers
                let cr = src.currentRatchet;
                let ekp = cr.ephemeralKeyPair;
                dst.currentRatchet.rootKey = cr.rootKey.toString('base64');
                dst.currentRatchet.lastRemoteEphemeralKey = cr.lastRemoteEphemeralKey.toString('base64');
                dst.currentRatchet.ephemeralKeyPair.pubKey = ekp.pubKey.toString('base64');
                dst.currentRatchet.ephemeralKeyPair.privKey = ekp.privKey.toString('base64');
                dst.indexInfo.remoteIdentityKey = src.indexInfo.remoteIdentityKey.toString('base64');
                return dst;
            }.bind(this));
            return {
                sessions,
                registrationId: this.registrationId,
                identityKey: this.identityKey.toString('binary')
            };
        },

        haveOpenSession: function() {
            return this.registrationId !== null;
        },

        getSessionByBaseKey: function(baseKey) {
            var session = this._sessions[baseKey.toString('base64')];
            if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
                console.log("Tried to lookup a session using our basekey");
                return undefined;
            }
            return session;
        },

        getSessionByRemoteEphemeralKey: function(remoteEphemeralKey) {
            this.detectDuplicateOpenSessions();
            var sessions = this._sessions;

            var searchKey = remoteEphemeralKey.toString('base64');

            var openSession;
            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    openSession = sessions[key];
                }
                if (sessions[key][searchKey] !== undefined) {
                    return sessions[key];
                }
            }
            if (openSession !== undefined) {
                return openSession;
            }

            return undefined;
        },

        getOpenSession: function() {
            var sessions = this._sessions;
            if (sessions === undefined) {
                return undefined;
            }

            this.detectDuplicateOpenSessions();

            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    return sessions[key];
                }
            }
            return undefined;
        },

        detectDuplicateOpenSessions: function() {
            var openSession;
            var sessions = this._sessions;
            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    if (openSession !== undefined) {
                        throw new Error("Datastore inconsistensy: multiple open sessions");
                    }
                    openSession = sessions[key];
                }
            }
        },

        updateSessionState: function(session, registrationId) {
            var sessions = this._sessions;

            this.removeOldChains(session);

            if (this.identityKey === null) {
                this.identityKey = session.indexInfo.remoteIdentityKey;
            }
            if (this.identityKey.toString('binary') !==
                session.indexInfo.remoteIdentityKey.toString('binary')) {
                var e = new Error("Identity key changed at session save time");
                e.identityKey = session.indexInfo.remoteIdentityKey;
                throw e;
            }

            sessions[session.indexInfo.baseKey.toString('base64')] = session;

            this.removeOldSessions();

            var openSessionRemaining = false;
            for (var key in sessions) {
                if (sessions[key].indexInfo.closed == -1) {
                    openSessionRemaining = true;
                }
            }
            if (!openSessionRemaining) { // Used as a flag to get new pre keys for the next session
                this.registrationId = null;
            } else if (this.registrationId === null && registrationId !== undefined) {
                this.registrationId = registrationId;
            } else if (this.registrationId === null) {
                throw new Error("Had open sessions on a record that had no registrationId set");
            }
        },

        getSessions: function() {
            // return an array of sessions ordered by time closed,
            // followed by the open session
            var list = [];
            var openSession;
            for (var k in this._sessions) {
                if (this._sessions[k].indexInfo.closed === -1) {
                    openSession = this._sessions[k];
                } else {
                    list.push(this._sessions[k]);
                }
            }
            list = list.sort(function(s1, s2) {
                return s1.indexInfo.closed - s2.indexInfo.closed;
            });
            if (openSession) {
                list.push(openSession);
            }
            return list;
        },

        archiveCurrentState: function() {
            var open_session = this.getOpenSession();
            if (open_session !== undefined) {
                this.closeSession(open_session);
                this.updateSessionState(open_session);
            }
        },

        closeSession: function(session) {
            if (session.indexInfo.closed > -1) {
                return;
            }
            console.log('closing session', session.indexInfo.baseKey);

            // After this has run, we can still receive messages on ratchet chains which
            // were already open (unless we know we dont need them),
            // but we cannot send messages or step the ratchet

            // Delete current sending ratchet
            delete session[session.currentRatchet.ephemeralKeyPair.pubKey.toString('base64')];
            // Move all receive ratchets to the oldRatchetList to mark them for deletion
            for (var i in session) {
                if (session[i].chainKey !== undefined && session[i].chainKey.key !== undefined) {
                    session.oldRatchetList[session.oldRatchetList.length] = {
                        added: Date.now(),
                        ephemeralKey: i
                    };
                }
            }
            session.indexInfo.closed = Date.now();
            this.removeOldChains(session);
        },

        removeOldChains: function(session) {
            // Sending ratchets are always removed when we step because we never need them again
            // Receiving ratchets are added to the oldRatchetList, which we parse
            // here and remove all but the last five.
            while (session.oldRatchetList.length > 5) {
                var index = 0;
                var oldest = session.oldRatchetList[0];
                for (var i = 0; i < session.oldRatchetList.length; i++) {
                    if (session.oldRatchetList[i].added < oldest.added) {
                        oldest = session.oldRatchetList[i];
                        index = i;
                    }
                }
                console.log("Deleting chain closed at", oldest.added);
                delete session[oldest.ephemeralKey.toString('base64')];
                session.oldRatchetList.splice(index, 1);
            }
        },

        removeOldSessions: function() {
            // Retain only the last 20 sessions
            var sessions = this._sessions;
            var oldestBaseKey, oldestSession;
            while (Object.keys(sessions).length > ARCHIVED_STATES_MAX_LENGTH) {
                for (var key in sessions) {
                    var session = sessions[key];
                    if (session.indexInfo.closed > -1 && // session is closed
                        (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
                        oldestBaseKey = key;
                        oldestSession = session;
                    }
                }
                console.log("Deleting session closed at", oldestSession.indexInfo.closed);
                delete sessions[oldestBaseKey];
            }
        }
    };

    return SessionRecord;
})();

module.exports = SessionRecord;
