// vim: ts=4:sw=4

'use strict';

const BaseKeyType = require('./base_key_type.js');

const ARCHIVED_STATES_MAX_LENGTH = 40;
const OLD_RATCHETS_MAX_LENGTH = 10;
const SESSION_RECORD_VERSION = 'v1';


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

    serialize() {
        const data = {
            currentRatchet: {
                ephemeralKeyPair: {
                    pubKey: this.currentRatchet.ephemeralKeyPair.pubKey.toString('base64'),
                    privKey: this.currentRatchet.ephemeralKeyPair.privKey.toString('base64')
                },
                lastRemoteEphemeralKey: this.currentRatchet.lastRemoteEphemeralKey.toString('base64'),
                previousCounter: this.currentRatchet.previousCounter,
                rootKey: this.currentRatchet.rootKey.toString('base64')
            },
            indexInfo: {
                baseKey: this.indexInfo.baseKey.toString('base64'),
                baseKeyType: this.indexInfo.baseKeyType,
                closed: this.indexInfo.closed,
                remoteIdentityKey: this.indexInfo.remoteIdentityKey.toString('base64')
            },
            oldRatchetList: this.oldRatchetList.map(function(x) {
                return {
                    added: x.added,
                    ephemeralKey: x.ephemeralKey.toString('base64')
                };
            }),
            _chains: this._serialize_chains(this._chains)
        };
        if (this.pendingPreKey) {
            data.pendingPreKey = Object.assign({}, this.pendingPreKey);
            data.pendingPreKey.baseKey = this.pendingPreKey.baseKey.toString('base64');
        }
        return data;
    }

    static deserialize(data) {
        const obj = new this();
        obj.currentRatchet = {
            ephemeralKeyPair: {
                pubKey: Buffer.from(data.currentRatchet.ephemeralKeyPair.pubKey, 'base64'),
                privKey: Buffer.from(data.currentRatchet.ephemeralKeyPair.privKey, 'base64')
            },
            lastRemoteEphemeralKey: Buffer.from(data.currentRatchet.lastRemoteEphemeralKey, 'base64'),
            previousCounter: data.currentRatchet.previousCounter,
            rootKey: Buffer.from(data.currentRatchet.rootKey, 'base64')
        };
        obj.indexInfo = {
            baseKey: Buffer.from(data.indexInfo.baseKey, 'base64'),
            baseKeyType: data.indexInfo.baseKeyType,
            closed: data.indexInfo.closed,
            remoteIdentityKey: Buffer.from(data.indexInfo.remoteIdentityKey, 'base64')
        };
        obj.oldRatchetList = data.oldRatchetList.map(function(x) {
            return {
                added: x.added,
                ephemeralKey: Buffer.from(x.ephemeralKey, 'base64')
            };
        });
        obj._chains = this._deserialize_chains(data._chains);
        if (data.pendingPreKey) {
            obj.pendingPreKey = Object.assign({}, data.pendingPreKey);
            obj.pendingPreKey.baseKey = Buffer.from(data.pendingPreKey.baseKey, 'base64');
        }
        return obj;
    }

    _serialize_chains(chains) {
        const r = {};
        for (const key of Object.keys(chains)) {
            const c = chains[key];
            const messageKeys = {};
            for (const [idx, key] of Object.entries(c.messageKeys)) {
                messageKeys[idx] = key.toString('base64');
            }
            r[key] = {
                chainKey: {
                    counter: c.chainKey.counter,
                    key: c.chainKey.key && c.chainKey.key.toString('base64')
                },
                chainType: c.chainType,
                messageKeys: messageKeys
            };
        }
        return r;
    }

    static _deserialize_chains(chains_data) {
        const r = {};
        for (const key of Object.keys(chains_data)) {
            const c = chains_data[key];
            const messageKeys = {};
            for (const [idx, key] of Object.entries(c.messageKeys)) {
                messageKeys[idx] = Buffer.from(key, 'base64');
            }
            r[key] = {
                chainKey: {
                    counter: c.chainKey.counter,
                    key: c.chainKey.key && Buffer.from(c.chainKey.key, 'base64')
                },
                chainType: c.chainType,
                messageKeys: messageKeys
            };
        }
        return r;
    }

}


const migrations = [{
    version: 'v1',
    migrate: function migrateV1(data) {
        const sessions = data.sessions;
        if (data.registrationId) {
            for (const key in sessions) {
                if (!sessions[key].registrationId) {
                    sessions[key].registrationId = data.registrationId;
                }
            }
        } else {
            for (const key in sessions) {
                if (sessions[key].indexInfo.closed === -1) {
                    console.error('V1 session storage migration error: registrationId',
                                  data.registrationId, 'for open session version',
                                  data.version);
                }
            }
        }
    }
}];




class SessionRecord {

    static createEntry() {
        return new SessionEntry();
    }

    static migrate(data) {
        let run = (data.version === undefined);
        for (let i = 0; i < migrations.length; ++i) {
            if (run) {
                console.info("Migrating session to:", migrations[i].version);
                migrations[i].migrate(data);
            } else if (migrations[i].version === data.version) {
                run = true;
            }
        }
        if (!run) {
            throw new Error("Error migrating SessionRecord");
        }
    }

    constructor() {
        this.sessions = {};
        this.version = SESSION_RECORD_VERSION;
    }

    haveOpenSession() {
        const openSession = this.getOpenSession();
        return (!!openSession && typeof openSession.registrationId === 'number');
    }

    getSessionByBaseKey(baseKey) {
        const session = this.sessions[baseKey.toString('base64')];
        if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
            console.log("Tried to lookup a session using our basekey");
            return;
        }
        return session;
    }

    getSessionByRemoteEphemeralKey(remoteEphemeralKey) {
        this.detectDuplicateOpenSessions();
        let openSession;
        for (const key in this.sessions) {
            const s = this.sessions[key];
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
        const sessions = this.sessions;
        if (sessions === undefined) {
            return;
        }
        this.detectDuplicateOpenSessions();
        for (const key in sessions) {
            if (sessions[key].indexInfo.closed == -1) {
                return sessions[key];
            }
        }
    }

    detectDuplicateOpenSessions() {
        let openSession;
        const sessions = this.sessions;
        for (const key in sessions) {
            if (sessions[key].indexInfo.closed == -1) {
                if (openSession !== undefined) {
                    throw new Error("Datastore inconsistensy: multiple open sessions");
                }
                openSession = sessions[key];
            }
        }
    }

    updateSessionState(session) {
        const sessions = this.sessions;
        this.removeOldChains(session);
        sessions[session.indexInfo.baseKey.toString('base64')] = session;
        this.removeOldSessions();
    }

    getSessions() {
        /* Return an array of sessions ordered by time closed, followed by the
         * open session. */
        const sessions = [];
        let openSession;
        for (const k in this.sessions) {
            if (this.sessions[k].indexInfo.closed === -1) {
                openSession = this.sessions[k];
            } else {
                sessions.push(this.sessions[k]);
            }
        }
        sessions.sort((s1, s2) => s1.indexInfo.closed - s2.indexInfo.closed);
        if (openSession) {
            sessions.push(openSession);
        }
        return sessions;
    }

    archiveCurrentState() {
        const open_session = this.getOpenSession();
        if (open_session !== undefined) {
            open_session.indexInfo.closed = Date.now();
            this.updateSessionState(open_session);
        }
    }

    promoteState(session) {
        session.indexInfo.closed = -1;
    }

    removeOldChains(session) {
        // Sending ratchets are always removed when we step because we never need them again
        // Receiving ratchets are added to the oldRatchetList, which we parse
        // here and remove all but the last ten.
        while (session.oldRatchetList.length > OLD_RATCHETS_MAX_LENGTH) {
            let index = 0;
            let oldest = session.oldRatchetList[0];
            for (let i = 0; i < session.oldRatchetList.length; i++) {
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
        const sessions = this.sessions;
        let oldestBaseKey, oldestSession;
        while (Object.keys(sessions).length > ARCHIVED_STATES_MAX_LENGTH) {
            for (const key in sessions) {
                const session = sessions[key];
                if (session.indexInfo.closed > -1 &&
                    (!oldestSession ||
                     session.indexInfo.closed < oldestSession.indexInfo.closed)) {
                    oldestBaseKey = key;
                    oldestSession = session;
                }
            }
            console.log("Deleting session closed at", oldestSession.indexInfo.closed);
            delete sessions[oldestBaseKey];
        }
    }

    serialize() {
        const sessions = {};
        for (const [key, entry] of Object.entries(this.sessions)) {
            sessions[key] = entry.serialize();
        }
        return {
            sessions,
            version: this.version
        };
    }

    static deserialize(data) {
        if (data.version !== SESSION_RECORD_VERSION) {
            this.migrate(data);
        }
        const obj = new this();
        for (const [key, entry_data] of Object.entries(data.sessions)) {
            obj.sessions[key] = SessionEntry.deserialize(entry_data);
        }
        return obj;
    }
}

module.exports = SessionRecord;
