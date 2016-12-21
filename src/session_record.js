/*
 * vim: ts=4:sw=4
 */

'use strict';

const ARCHIVED_STATES_MAX_LENGTH = 40;
const BaseKeyType = require('./base_key_type.js');

const MESSAGE_LOST_THRESHOLD_MS = 1000*60*60*24*7;


class SessionEntry {

    constructor() {
        this._chains = {};
    }

    addChain(key, value) {
        if (!Buffer.isBuffer(key)) {
            throw new TypeError("Buffer Type Required");
        }
        const id = key.toString('base64');
        if (this._chains.hasOwnProperty(id)) {
            throw new Error("maybe okay, but blowing for now! overwrite attempt");
        }
        this._chains[id] = value;
    }
    
    getChain(key) {
        if (!Buffer.isBuffer(key)) {
            throw new TypeError("Buffer Type Required");
        }
        return this._chains[key.toString('base64')];
    }

    deleteChain(key) {
        if (!Buffer.isBuffer(key)) {
            throw new TypeError("Buffer Type Required");
        }
        const id = key.toString('base64');
        if (!this._chains.hasOwnProperty(id)) {
            throw new Error("Not Found");
        }
        delete this._chains[id];
    }

    *chains() {
        for (const [k, v] of Object.entries(this._chains)) {
            yield [Buffer.from(k, 'base64'), v];
        }
    }
}


class SessionRecord {

    static createEntry() {
        return new SessionEntry();
    }

    constructor(identityKey, registrationId) {
        this._sessions = {};
        if (!(identityKey instanceof Buffer)) {
            throw new TypeError('identityKey must be Buffer');
        }
        this.identityKey = identityKey;
        this.registrationId = registrationId;

        if (this.registrationId === undefined ||
            typeof this.registrationId !== 'number') {
            this.registrationId = null;
        }
    }

    haveOpenSession() {
        return this.registrationId !== null;
    }

    getSessionByBaseKey(baseKey) {
        var session = this._sessions[baseKey.toString('base64')];
        if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
            console.log("Tried to lookup a session using our basekey");
            return;
        }
        return session;
    }

    getSessionByRemoteEphemeralKey(remoteEphemeralKey) {
        this.detectDuplicateOpenSessions();
        let openSession;
        for (const key in this._sessions) {
            const s = this._sessions[key];
            if (s.getChain(remoteEphemeralKey) !== undefined) {
                return s;
            }
            if (s.indexInfo.closed == -1) {
                openSession = s;
            }
        }
        return openSession;
    }

    getOpenSession() {
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
        return;
    }

    detectDuplicateOpenSessions() {
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
    }

    updateSessionState(session, registrationId) {
        var sessions = this._sessions;

        this.removeOldChains(session);

        if (this.identityKey === null) {
            this.identityKey = session.indexInfo.remoteIdentityKey;
        }
        if (!this.identityKey.equals(session.indexInfo.remoteIdentityKey)) {
            console.log(this.identityKey);
            console.log(session.indexInfo.remoteIdentityKey);
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
    }

    getSessions() {
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
    }

    archiveCurrentState() {
        var open_session = this.getOpenSession();
        if (open_session !== undefined) {
            this.closeSession(open_session);
            this.updateSessionState(open_session);
        }
    }

    closeSession(session) {
        if (session.indexInfo.closed > -1) {
            return;
        }
        console.log('closing session', session.indexInfo.baseKey);

        // After this has run, we can still receive messages on ratchet chains which
        // were already open (unless we know we dont need them),
        // but we cannot send messages or step the ratchet

        session.deleteChain(session.currentRatchet.ephemeralKeyPair.pubKey);
        // Move all receive ratchets to the oldRatchetList to mark them for deletion
        for (const [key, chain] of session.chains()) {
            if (chain.chainKey !== undefined &&
                chain.chainKey.key !== undefined) {
                session.oldRatchetList[session.oldRatchetList.length] = {
                    added: Date.now(),
                    ephemeralKey: Buffer.from(key, 'base64')
                };
            }
        }
        session.indexInfo.closed = Date.now();
        this.removeOldChains(session);
    }

    removeOldChains(session) {
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
            session.deleteChain(oldest.ephemeralKey);
            session.oldRatchetList.splice(index, 1);
        }
    }

    removeOldSessions() {
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
}

module.exports = SessionRecord;
