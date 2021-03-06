/* globals onLoadWorkerLoadAsmCrypto */

var _ = require('lodash'),
    q = require('q'),
    bitcoin = require('bitcoinjs-lib'),
    bitcoinMessage = require('bitcoinjs-message'),

    bip39 = require("bip39"),
    Wallet = require('./wallet'),
    BtccomConverter = require('./btccom.convert'),
    BlocktrailConverter = require('./blocktrail.convert'),
    RestClient = require('./rest_client'),
    Encryption = require('./encryption'),
    KeyDerivation = require('./keyderivation'),
    EncryptionMnemonic = require('./encryption_mnemonic'),
    blocktrail = require('./blocktrail'),
    randomBytes = require('randombytes'),
    CryptoJS = require('crypto-js'),
    webworkifier = require('./webworkifier');

/**
 *
 * @param opt
 * @returns {*}
 */
function networkFromOptions(opt) {
    if (opt.bitcoinCash) {
        if (opt.regtest) {
            return bitcoin.networks.bitcoincashregtest;
        } else if (opt.testnet) {
            return bitcoin.networks.bitcoincashtestnet;
        } else {
            return bitcoin.networks.bitcoincash;
        }
    } else {
        if (opt.regtest) {
            return bitcoin.networks.regtest;
        } else if (opt.testnet) {
            return bitcoin.networks.testnet;
        } else {
            return bitcoin.networks.bitcoin;
        }
    }
}

var useWebWorker = require('./use-webworker')();


/**
 * helper to wrap a promise so that the callback get's called when it succeeds or fails
 *
 * @param promise   {q.Promise}
 * @param cb        function
 * @return q.Promise
 */
function callbackify(promise, cb) {
    // add a .then to trigger the cb for people using callbacks
    if (cb) {
        promise
            .then(function(res) {
                // use q.nextTick for asyncness
                q.nextTick(function() {
                    cb(null, res);
                });
            }, function(err) {
                // use q.nextTick for asyncness
                q.nextTick(function() {
                    cb(err, null);
                });
            });
    }

    // return the promise for people using promises
    return promise;
}

/**
 * Bindings to consume the BlockTrail API
 *
 * @param options       object{
 *                          apiKey: 'API_KEY',
 *                          apiSecret: 'API_SECRET',
 *                          host: 'defaults to api.blocktrail.com',
 *                          network: 'BTC|LTC',
 *                          testnet: true|false
 *                      }
 * @constructor
 */
var APIClient = function(options) {
    var self = this;

    // handle constructor call without 'new'
    if (!(this instanceof APIClient)) {
        return new APIClient(options);
    }

    var normalizedNetwork = APIClient.normalizeNetworkFromOptions(options);
    options.network = normalizedNetwork[0];
    options.testnet = normalizedNetwork[1];
    options.regtest = normalizedNetwork[2];
    // apiNetwork we allow to be customized for debugging purposes
    options.apiNetwork = options.apiNetwork || normalizedNetwork[3];

    self.bitcoinCash = options.network === "BCC";
    self.regtest = options.regtest;
    self.testnet = options.testnet;
    self.network = networkFromOptions(self);
    self.feeSanityCheck = typeof options.feeSanityCheck !== "undefined" ? options.feeSanityCheck : true;
    self.feeSanityCheckBaseFeeMultiplier = options.feeSanityCheckBaseFeeMultiplier || 200;

    options.apiNetwork = options.apiNetwork || ((self.testnet ? "t" : "") + (options.network || 'BTC').toUpperCase());

    if (typeof options.btccom === "undefined") {
        options.btccom = true;
    }

    /**
     * @type RestClient
     */
    var dataOptions = _.omit(options, 'host');
    self.dataClient = APIClient.initRestClient(dataOptions);
    /**
     * @type RestClient
     */
    self.blocktrailClient = APIClient.initRestClient(_.merge({}, options, {btccom: false}));

    if (options.btccom) {
        self.converter = new BtccomConverter(self.network, true);
    } else {
        self.converter = new BlocktrailConverter();
    }

};

APIClient.normalizeNetworkFromOptions = function(options) {
    /* jshint -W071, -W074 */
    var network = 'BTC';
    var testnet = false;
    var regtest = false;
    var apiNetwork = "BTC";

    var prefix;
    var done = false;

    if (options.network) {
        var lower = options.network.toLowerCase();

        var m = lower.match(/^([rt])?(btc|bch|bcc)$/);
        if (!m) {
            throw new Error("Invalid network [" + options.network + "]");
        }

        if (m[2] === 'btc') {
            network = "BTC";
        } else {
            network = "BCC";
        }

        prefix = m[1];
        if (prefix) {
            // if there's a prefix then we're "done", won't apply options.regtest and options.testnet after
            done = true;
            if (prefix === 'r') {
                testnet = true;
                regtest = true;
            } else if (prefix === 't') {
                testnet = true;
            }
        }
    }

    // if we're not already done then apply options.regtest and options.testnet
    if (!done) {
        if (options.regtest) {
            testnet = true;
            regtest = true;
            prefix = "r";
        } else if (options.testnet) {
            testnet = true;
            prefix = "t";
        }
    }

    apiNetwork = (prefix || "") + network;

    return [network, testnet, regtest, apiNetwork];
};

APIClient.updateHostOptions = function(options) {
    /* jshint -W071, -W074 */
    // BLOCKTRAIL_SDK_API_ENDPOINT overwrite for development
    if (!options.btccom && process.env.BLOCKTRAIL_SDK_API_ENDPOINT) {
        options.host = process.env.BLOCKTRAIL_SDK_API_ENDPOINT;
    }
    if (options.btccom && process.env.BLOCKTRAIL_SDK_BTCCOM_API_ENDPOINT) {
        options.host = process.env.BLOCKTRAIL_SDK_BTCCOM_API_ENDPOINT;
    }

    if (options.btccom && process.env.BLOCKTRAIL_SDK_THROTTLE_BTCCOM) {
        options.throttleRequestsTimeout = process.env.BLOCKTRAIL_SDK_THROTTLE_BTCCOM;
    }

    if (options.btccom) {
        if (!options.host) {
            options.host = options.btccomhost || (options.network === 'BCC' ? 'bch-chain.api.btc.com' : 'chain.api.btc.com');
        }

        if (options.testnet && !options.host.match(/tchain/)) {
            options.host = options.host.replace(/chain/, 'tchain');
        }

        if (!options.endpoint) {
            options.endpoint = options.btccomendpoint || ("/" + (options.apiVersion || "v3"));
        }
    } else {
        if (!options.host) {
            options.host = 'api.blocktrail.com';
        }

        if (!options.endpoint) {
            options.endpoint = "/" + (options.apiVersion || "v1") + (options.apiNetwork ? ("/" + options.apiNetwork) : "");
        }
    }

    // trim off leading https?://
    if (options.host && options.host.indexOf("https://") === 0) {
        options.https = true;
        options.host = options.host.substr(8);
    } else if (options.host && options.host.indexOf("http://") === 0) {
        options.https = false;
        options.host = options.host.substr(7);
    }

    if (typeof options.https === "undefined") {
        options.https = true;
    }

    if (!options.port) {
        options.port = options.https ? 443 : 80;
    }

    return options;
};

APIClient.initRestClient = function(options) {
    options = APIClient.updateHostOptions(options);
    return new RestClient(options);
};

var determineDataStorageV2_3 = function(options) {
    return q.when(options)
        .then(function(options) {
            // legacy
            if (options.storePrimaryMnemonic) {
                options.storeDataOnServer = options.storePrimaryMnemonic;
            }

            // storeDataOnServer=false when primarySeed is provided
            if (typeof options.storeDataOnServer === "undefined") {
                options.storeDataOnServer = !options.primarySeed;
            }

            return options;
        });
};

var produceEncryptedDataV2 = function(options, notify) {
    return q.when(options)
        .then(function(options) {
            if (options.storeDataOnServer) {
                if (!options.secret) {
                    if (!options.passphrase) {
                        throw new blocktrail.WalletCreateError("Can't encrypt data without a passphrase");
                    }

                    notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_SECRET);

                    options.secret = randomBytes(Wallet.WALLET_ENTROPY_BITS / 8).toString('hex'); // string because we use it as passphrase
                    options.encryptedSecret = CryptoJS.AES.encrypt(options.secret, options.passphrase).toString(CryptoJS.format.OpenSSL); // 'base64' string
                }

                notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_PRIMARY);

                options.encryptedPrimarySeed = CryptoJS.AES.encrypt(options.primarySeed.toString('base64'), options.secret)
                    .toString(CryptoJS.format.OpenSSL); // 'base64' string
                options.recoverySecret = randomBytes(Wallet.WALLET_ENTROPY_BITS / 8).toString('hex'); // string because we use it as passphrase

                notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_RECOVERY);

                options.recoveryEncryptedSecret = CryptoJS.AES.encrypt(options.secret, options.recoverySecret)
                                                              .toString(CryptoJS.format.OpenSSL); // 'base64' string
            }

            return options;
        });
};

APIClient.prototype.promisedEncrypt = function(pt, pw, iter) {
    if (useWebWorker && typeof onLoadWorkerLoadAsmCrypto === "function") {
        // generate randomness outside of webworker because many browsers don't have crypto.getRandomValues inside webworkers
        var saltBuf = Encryption.generateSalt();
        var iv = Encryption.generateIV();

        return webworkifier.workify(APIClient.prototype.promisedEncrypt, function factory() {
            return require('./webworker');
        }, onLoadWorkerLoadAsmCrypto, {
            method: 'Encryption.encryptWithSaltAndIV',
            pt: pt,
            pw: pw,
            saltBuf: saltBuf,
            iv: iv,
            iterations: iter
        })
            .then(function(data) {
                return Buffer.from(data.cipherText.buffer);
            });
    } else {
        try {
            return q.when(Encryption.encrypt(pt, pw, iter));
        } catch (e) {
            return q.reject(e);
        }
    }
};

APIClient.prototype.promisedDecrypt = function(ct, pw) {
    if (useWebWorker && typeof onLoadWorkerLoadAsmCrypto === "function") {
        return webworkifier.workify(APIClient.prototype.promisedDecrypt, function() {
            return require('./webworker');
        }, onLoadWorkerLoadAsmCrypto, {
            method: 'Encryption.decrypt',
            ct: ct,
            pw: pw
        })
            .then(function(data) {
                return Buffer.from(data.plainText.buffer);
            });
    } else {
        try {
            return q.when(Encryption.decrypt(ct, pw));
        } catch (e) {
            return q.reject(e);
        }
    }
};

APIClient.prototype.produceEncryptedDataV3 = function(options, notify) {
    var self = this;

    return q.when(options)
        .then(function(options) {
            if (options.storeDataOnServer) {
                return q.when()
                    .then(function() {
                        if (!options.secret) {
                            if (!options.passphrase) {
                                throw new blocktrail.WalletCreateError("Can't encrypt data without a passphrase");
                            }

                            notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_SECRET);

                            // -> now a buffer
                            options.secret = randomBytes(Wallet.WALLET_ENTROPY_BITS / 8);

                            // -> now a buffer
                            return self.promisedEncrypt(options.secret, new Buffer(options.passphrase), KeyDerivation.defaultIterations)
                                .then(function(encryptedSecret) {
                                    options.encryptedSecret = encryptedSecret;
                                });
                        } else {
                            if (!(options.secret instanceof Buffer)) {
                                throw new Error('Secret must be a buffer');
                            }
                        }
                    })
                    .then(function() {
                        notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_PRIMARY);

                        return self.promisedEncrypt(options.primarySeed, options.secret, KeyDerivation.subkeyIterations)
                            .then(function(encryptedPrimarySeed) {
                                options.encryptedPrimarySeed = encryptedPrimarySeed;
                            });
                    })
                    .then(function() {
                        // skip generating recovery secret when explicitly set to false
                        if (options.recoverySecret === false) {
                            return;
                        }

                        notify(APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_RECOVERY);
                        if (!options.recoverySecret) {
                            options.recoverySecret = randomBytes(Wallet.WALLET_ENTROPY_BITS / 8);
                        }

                        return self.promisedEncrypt(options.secret, options.recoverySecret, KeyDerivation.defaultIterations)
                            .then(function(recoveryEncryptedSecret) {
                                options.recoveryEncryptedSecret = recoveryEncryptedSecret;
                            });
                    })
                    .then(function() {
                        return options;
                    });
            } else {
                return options;
            }
        });
};

var doRemainingWalletDataV2_3 = function(options, network, notify) {
    return q.when(options)
        .then(function(options) {
            if (!options.backupPublicKey) {
                options.backupSeed = options.backupSeed || randomBytes(Wallet.WALLET_ENTROPY_BITS / 8);
            }

            notify(APIClient.CREATE_WALLET_PROGRESS_PRIMARY);

            options.primaryPrivateKey = bitcoin.HDNode.fromSeedBuffer(options.primarySeed, network);

            notify(APIClient.CREATE_WALLET_PROGRESS_BACKUP);

            if (!options.backupPublicKey) {
                options.backupPrivateKey = bitcoin.HDNode.fromSeedBuffer(options.backupSeed, network);
                options.backupPublicKey = options.backupPrivateKey.neutered();
            }

            options.primaryPublicKey = options.primaryPrivateKey.deriveHardened(options.keyIndex).neutered();

            notify(APIClient.CREATE_WALLET_PROGRESS_SUBMIT);

            return options;
        });
};

APIClient.prototype.mnemonicToPrivateKey = function(mnemonic, passphrase, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    deferred.resolve(q.fcall(function() {
        return self.mnemonicToSeedHex(mnemonic, passphrase).then(function(seedHex) {
            return bitcoin.HDNode.fromSeedHex(seedHex, self.network);
        });
    }));

    return deferred.promise;
};

APIClient.prototype.mnemonicToSeedHex = function(mnemonic, passphrase) {
    var self = this;

    if (useWebWorker) {
        return webworkifier.workify(self.mnemonicToSeedHex, function() {
            return require('./webworker');
        }, {method: 'mnemonicToSeedHex', mnemonic: mnemonic, passphrase: passphrase})
            .then(function(data) {
                return data.seed;
            });
    } else {
        try {
            return q.when(bip39.mnemonicToSeedHex(mnemonic, passphrase));
        } catch (e) {
            return q.reject(e);
        }
    }
};

APIClient.prototype.resolvePrimaryPrivateKeyFromOptions = function(options, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.nodeify(cb);

    try {
        // avoid conflicting options
        if (options.passphrase && options.password) {
            throw new blocktrail.WalletCreateError("Can't specify passphrase and password");
        }
        // normalize passphrase/password
        options.passphrase = options.passphrase || options.password;
        delete options.password;

        // avoid conflicting options
        if (options.primaryMnemonic && options.primarySeed) {
            throw new blocktrail.WalletInitError("Can only specify one of; Primary Mnemonic or Primary Seed");
        }

        // avoid deprecated options
        if (options.primaryPrivateKey) {
            throw new blocktrail.WalletInitError("Can't specify; Primary PrivateKey");
        }

        // make sure we have at least one thing to use
        if (!options.primaryMnemonic && !options.primarySeed) {
            throw new blocktrail.WalletInitError("Need to specify at least one of; Primary Mnemonic or Primary Seed");
        }

        if (options.primarySeed) {
            self.primarySeed = options.primarySeed;
            options.primaryPrivateKey = bitcoin.HDNode.fromSeedBuffer(self.primarySeed, self.network);
            deferred.resolve(options);
        } else {
            if (!options.passphrase) {
                throw new blocktrail.WalletInitError("Can't init wallet with Primary Mnemonic without a passphrase");
            }

            self.mnemonicToSeedHex(options.primaryMnemonic, options.passphrase)
                .then(function(seedHex) {
                    try {
                        options.primarySeed = new Buffer(seedHex, 'hex');
                        options.primaryPrivateKey = bitcoin.HDNode.fromSeedBuffer(options.primarySeed, self.network);
                        deferred.resolve(options);
                    } catch (e) {
                        deferred.reject(e);
                    }
                }, function(e) {
                    deferred.reject(e);
                });
        }
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};

APIClient.prototype.resolveBackupPublicKeyFromOptions = function(options, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.nodeify(cb);

    try {
        // avoid conflicting options
        if (options.backupMnemonic && options.backupPublicKey) {
            throw new blocktrail.WalletInitError("Can only specify one of; Backup Mnemonic or Backup PublicKey");
        }

        // make sure we have at least one thing to use
        if (!options.backupMnemonic && !options.backupPublicKey) {
            throw new blocktrail.WalletInitError("Need to specify at least one of; Backup Mnemonic or Backup PublicKey");
        }

        if (options.backupPublicKey) {
            if (options.backupPublicKey instanceof bitcoin.HDNode) {
                deferred.resolve(options);
            } else {
                options.backupPublicKey = bitcoin.HDNode.fromBase58(options.backupPublicKey, self.network);
                deferred.resolve(options);
            }
        } else {
            self.mnemonicToPrivateKey(options.backupMnemonic, "").then(function(backupPrivateKey) {
                options.backupPublicKey = backupPrivateKey.neutered();
                deferred.resolve(options);
            }, function(e) {
                deferred.reject(e);
            });
        }
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};

APIClient.prototype.debugAuth = function(cb) {
    var self = this;

    return self.dataClient.get("/debug/http-signature", null, true, cb);
};

/**
 * get a single address
 *
 * @param address      string       address hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.address = function(address, cb) {
    var self = this;

    return callbackify(self.dataClient.get(self.converter.getUrlForAddress(address), null)
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            if (data === null) {
                return data;
            } else {
                return self.converter.convertAddress(data);
            }
        }), cb);
};

APIClient.prototype.addresses = function(addresses, cb) {
    var self = this;

    return callbackify(self.dataClient.post("/address", null, {"addresses": addresses}), cb);
};


/**
 * get all transactions for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressTransactions = function(address, params, cb) {

    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return callbackify(self.dataClient.get(self.converter.getUrlForAddressTransactions(address), self.converter.paginationParams(params))
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            return data.data === null ? data : self.converter.convertAddressTxs(data);
        }), cb);
};

/**
 * get all transactions for a batch of addresses (paginated)
 *
 * @param addresses     array       address hashes
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.batchAddressHasTransactions = function(addresses, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    var deferred = q.defer();

    var promise = q();

    addresses.forEach(function(address) {
        promise = promise.then(function(hasTxs) {
            if (hasTxs) {
                return hasTxs;
            }

            return q(address)
                .then(function(address) {
                    console.log(address);
                    return self.addressTransactions(address, params)
                        .then(function(res) {
                            // err_no=1 is no txs found
                            if (res.err_no === 1) {
                                return false;
                            } else if (res.err_no) {
                                throw new Error("err: " + res.err_msg);
                            }

                            return res.data && res.data.length > 0;
                        });
                });
        });
    });

    promise.then(function(hasTxs) {
        deferred.resolve({has_transactions: hasTxs});
    }, function(err) {
        deferred.reject(err);
    });

    return callbackify(deferred.promise, cb);
};

/**
 * get all unconfirmed transactions for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressUnconfirmedTransactions = function(address, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return callbackify(self.dataClient.get(self.converter.getUrlForAddressTransactions(address), self.converter.paginationParams(params))
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            if (data.data === null) {
                return data;
            }

            var res = self.converter.convertAddressTxs(data);
            res.data = res.data.filter(function(tx) {
                return !tx.confirmations;
            });

            return res;
        }), cb);
};

/**
 * get all unspent outputs for an address (paginated)
 *
 * @param address       string      address hash
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.addressUnspentOutputs = function(address, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return callbackify(self.dataClient.get(self.converter.getUrlForAddressUnspent(address), self.converter.paginationParams(params))
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            return data.data === null ? data : self.converter.convertAddressUnspentOutputs(data, address);
        }), cb);
};

/**
 * get all unspent outputs for a batch of addresses (paginated)
 *
 * @param addresses     array       address hashes
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.batchAddressUnspentOutputs = function(addresses, params, cb) {
    var self = this;

    if (self.converter instanceof BtccomConverter) {
        return callbackify(self.dataClient.get(self.converter.getUrlForBatchAddressUnspent(addresses), self.converter.paginationParams(params))
            .then(function(data) {
                return self.converter.handleErrors(self, data);
            })
            .then(function(data) {
                return data.data === null ? data : self.converter.convertBatchAddressUnspentOutputs(data);
            }), cb);
    } else {

        if (typeof params === "function") {
            cb = params;
            params = null;
        }

        return callbackify(self.dataClient.post("/address/unspent-outputs", params, {"addresses": addresses}), cb);
    }
};

/**
 * verify ownership of an address
 *
 * @param address       string      address hash
 * @param signature     string      a signed message (the address hash) using the private key of the address
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.verifyAddress = function(address, signature, cb) {
    var self = this;

    return self.verifyMessage(address, address, signature, cb);
};

/**
 *
 * get all blocks (paginated)
 * ASK
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allBlocks = function(params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return callbackify(self.dataClient.get(self.converter.getUrlForAllBlocks(), self.converter.paginationParams(params))
            .then(function(data) {
                return self.converter.handleErrors(self, data);
            })
            .then(function(data) {
                return data.data === null ? data : self.converter.convertBlocks(data);
            }), cb);
};

/**
 * get a block
 *
 * @param block         string|int  a block hash or a block height
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.block = function(block, cb) {
    var self = this;

    return callbackify(self.dataClient.get(self.converter.getUrlForBlock(block), null)
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            return data.data === null ? data : self.converter.convertBlock(data.data);
        }), cb);
};

/**
 * get the latest block
 *
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.blockLatest = function(cb) {
    var self = this;

    return callbackify(self.dataClient.get(self.converter.getUrlForBlock("latest"), null)
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            return data.data === null ? data : self.converter.convertBlock(data.data);
        }), cb);
};

/**
 * get all transactions for a block (paginated)
 *
 * @param block         string|int  a block hash or a block height
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.blockTransactions = function(block, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return callbackify(self.dataClient.get(self.converter.getUrlForBlockTransaction(block), self.converter.paginationParams(params))
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            return data.data ===  null ? data : self.converter.convertBlockTxs(data);
        }), cb);
};

/**
 * get a single transaction
 *
 * @param tx            string      transaction hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.transaction = function(tx, cb) {
    var self = this;

    return callbackify(self.dataClient.get(self.converter.getUrlForTransaction(tx), null)
        .then(function(data) {
            return self.converter.handleErrors(self, data);
        })
        .then(function(data) {
            if (data.data === null) {
                return data;
            } else {
                // for BTC.com API we need to fetch the raw hex from the BTC.com explorer endpoint
                if (self.converter instanceof BtccomConverter) {
                    return self.dataClient.get(self.converter.getUrlForRawTransaction(tx), null)
                        .then(function(rawData) {
                            return [data, rawData.data];
                        })
                        .then(function(dataAndTx) {
                            if (dataAndTx !== null) {
                                var data = dataAndTx[0];
                                var rawTx = dataAndTx[1];
                                return self.converter.convertTx(data, rawTx);
                            } else {
                                return dataAndTx;
                            }
                        });
                } else {
                    return self.converter.convertTx(data);
                }
            }
        }), cb);
};

/**
 * get a batch of transactions
 *
 * @param txs           string[]    list of transaction hashes (txId)
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.transactions = function(txs, cb) {
    var self = this;

    if (self.converter instanceof BtccomConverter) {
        return callbackify(self.dataClient.get(self.converter.getUrlForTransactions(txs), null)
            .then(function(data) {
                return self.converter.handleErrors(self, data);
            })
            .then(function(data) {
                if (data.data === null) {
                    return data;
                } else {
                    return self.converter.convertTxs(data);
                }
            }), cb);
    } else {
        return callbackify(self.dataClient.post("/transactions", null, txs, null, false), cb);
    }
};

/**
 * get a paginated list of all webhooks associated with the api user
 *
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allWebhooks = function(params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/webhooks", params, cb);
};

/**
 * create a new webhook
 *
 * @param url           string      the url to receive the webhook events
 * @param [identifier]  string      a unique identifier associated with the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.setupWebhook = function(url, identifier, cb) {
    var self = this;

    if (typeof identifier === "function") {
        //mimic function overloading
        cb = identifier;
        identifier = null;
    }

    return self.blocktrailClient.post("/webhook", null, {url: url, identifier: identifier}, cb);
};

/**
 * Converts a cash address to the legacy (base58) format
 * @param {string} input
 * @returns {string}
 */
APIClient.prototype.getLegacyBitcoinCashAddress = function(input) {
    if (this.network === bitcoin.networks.bitcoincash ||
        this.network === bitcoin.networks.bitcoincashtestnet ||
        this.network === bitcoin.networks.bitcoincashregtest) {
        var address;
        try {
            bitcoin.address.fromBase58Check(input, this.network);
            return input;
        } catch (e) {}

        address = bitcoin.address.fromCashAddress(input, this.network);
        var prefix;
        if (address.version === bitcoin.script.types.P2PKH) {
            prefix = this.network.pubKeyHash;
        } else if (address.version === bitcoin.script.types.P2SH) {
            prefix = this.network.scriptHash;
        } else {
            throw new Error("Unsupported address type");
        }

        return bitcoin.address.toBase58Check(address.hash, prefix);
    }

    throw new Error("Cash addresses only work on bitcoin cash");
};

/**
 * Converts a legacy bitcoin to the new cashaddr format
 * @param {string} input
 * @returns {string}
 */
APIClient.prototype.getCashAddressFromLegacyAddress = function(input) {
    if (this.network === bitcoin.networks.bitcoincash ||
        this.network === bitcoin.networks.bitcoincashtestnet ||
        this.network === bitcoin.networks.bitcoincashregtest
    ) {
        var address;
        try {
            bitcoin.address.fromCashAddress(input, this.network);
            return input;
        } catch (e) {}

        address = bitcoin.address.fromBase58Check(input, this.network);
        var scriptType;
        if (address.version === this.network.pubKeyHash) {
            scriptType = bitcoin.script.types.P2PKH;
        } else if (address.version === this.network.scriptHash) {
            scriptType = bitcoin.script.types.P2SH;
        } else {
            throw new Error("Unsupported address type");
        }

        return bitcoin.address.toCashAddress(address.hash, scriptType, this.network.cashAddrPrefix);
    }

    throw new Error("Cash addresses only work on bitcoin cash");
};

/**
 * get an existing webhook by it's identifier
 *
 * @param identifier    string      the unique identifier of the webhook to get
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.getWebhook = function(identifier, cb) {
    var self = this;

    return self.blocktrailClient.get("/webhook/" + identifier, null, cb);
};

/**
 * update an existing webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param webhookData   object      the data to update: {identifier: newIdentifier, url:newUrl}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.updateWebhook = function(identifier, webhookData, cb) {
    var self = this;

    return self.blocktrailClient.put("/webhook/" + identifier, null, webhookData, cb);
};

/**
 * deletes an existing webhook and any event subscriptions associated with it
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.deleteWebhook = function(identifier, cb) {
    var self = this;

    return self.blocktrailClient.delete("/webhook/" + identifier, null, null, cb);
};

/**
 * get a paginated list of all the events a webhook is subscribed to
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.getWebhookEvents = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/webhook/" + identifier + "/events", params, cb);
};

/**
 * subscribes a webhook to transaction events for a particular transaction
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param transaction   string      the transaction hash
 * @param confirmations integer     the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeTransaction = function(identifier, transaction, confirmations, cb) {
    var self = this;
    var postData = {
        'event_type': 'transaction',
        'transaction': transaction,
        'confirmations': confirmations
    };

    return self.blocktrailClient.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * subscribes a webhook to transaction events on a particular address
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param address       string      the address hash
 * @param confirmations integer     the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeAddressTransactions = function(identifier, address, confirmations, cb) {
    var self = this;
    var postData = {
        'event_type': 'address-transactions',
        'address': address,
        'confirmations': confirmations
    };

    return self.blocktrailClient.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * batch subscribes a webhook to multiple transaction events
 *
 * @param  identifier   string      the unique identifier of the webhook
 * @param  batchData    array       An array of objects containing batch event data:
 *                                  {address : 'address', confirmations : 'confirmations']
 *                                  where address is the address to subscribe to and confirmations (optional) is the amount of confirmations to send
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.batchSubscribeAddressTransactions = function(identifier, batchData, cb) {
    var self = this;
    batchData.forEach(function(record) {
        record.event_type = 'address-transactions';
    });

    return self.blocktrailClient.post("/webhook/" + identifier + "/events/batch", null, batchData, cb);
};

/**
 * subscribes a webhook to a new block event
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.subscribeNewBlocks = function(identifier, cb) {
    var self = this;
    var postData = {
        'event_type': 'block'
    };

    return self.blocktrailClient.post("/webhook/" + identifier + "/events", null, postData, cb);
};

/**
 * removes an address transaction event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param address       string      the address hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeAddressTransactions = function(identifier, address, cb) {
    var self = this;

    return self.blocktrailClient.delete("/webhook/" + identifier + "/address-transactions/" + address, null, null, cb);
};

/**
 * removes an transaction event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param transaction   string      the transaction hash
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeTransaction = function(identifier, transaction, cb) {
    var self = this;

    return self.blocktrailClient.delete("/webhook/" + identifier + "/transaction/" + transaction, null, null, cb);
};

/**
 * removes a block event subscription from a webhook
 *
 * @param identifier    string      the unique identifier of the webhook
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.unsubscribeNewBlocks = function(identifier, cb) {
    var self = this;

    return self.blocktrailClient.delete("/webhook/" + identifier + "/block", null, null, cb);
};

/**
 * Returns ['hash' => x, 'height' => y] for wallet API's chain tip
 *
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.getWalletLatestBlock = function(cb) {
    var self = this;

    return self.blocktrailClient.get("/block/latest", null, cb);
};

/**
 * initialize an existing wallet
 *
 * Either takes two argument:
 * @param options       object      {}
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * Or takes three arguments (old, deprecated syntax):
 * @param identifier    string      the wallet identifier to be initialized
 * @param passphrase    string      the password to decrypt the mnemonic with
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * @returns {q.Promise}
 */
APIClient.prototype.initWallet = function(options, cb) {
    var self = this;

    if (typeof options !== "object") {
        // get the old-style arguments
        options = {
            identifier: arguments[0],
            passphrase: arguments[1]
        };

        cb = arguments[2];
    }

    if (options.check_backup_key) {
        if (typeof options.check_backup_key !== "string") {
            throw new Error("Invalid input, must provide the backup key as a string (the xpub)");
        }
    }

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var identifier = options.identifier;

    if (!identifier) {
        deferred.reject(new blocktrail.WalletInitError("Identifier is required"));
        return deferred.promise;
    }

    deferred.resolve(self.blocktrailClient.get("/wallet/" + identifier, null, true).then(function(result) {
        var keyIndex = options.keyIndex || result.key_index;

        options.walletVersion = result.wallet_version;

        if (options.check_backup_key) {
            if (options.check_backup_key !== result.backup_public_key[0]) {
                throw new Error("Backup key returned from server didn't match our own copy");
            }
        }
        var backupPublicKey = bitcoin.HDNode.fromBase58(result.backup_public_key[0], self.network);
        var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
            return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
        });
        var primaryPublicKeys = _.mapValues(result.primary_public_keys, function(primaryPublicKey) {
            return bitcoin.HDNode.fromBase58(primaryPublicKey[0], self.network);
        });

        // initialize wallet
        var wallet = new Wallet(
            self,
            identifier,
            options.walletVersion,
            result.primary_mnemonic,
            result.encrypted_primary_seed,
            result.encrypted_secret,
            primaryPublicKeys,
            backupPublicKey,
            blocktrailPublicKeys,
            keyIndex,
            result.segwit || 0,
            self.testnet,
            self.regtest,
            result.checksum,
            result.upgrade_key_index,
            options.useCashAddress,
            options.bypassNewAddressCheck
        );

        wallet.recoverySecret = result.recovery_secret;

        if (!options.readOnly) {
            return wallet.unlock(options).then(function() {
                return wallet;
            });
        } else {
            return wallet;
        }
    }));

    return deferred.promise;
};

APIClient.CREATE_WALLET_PROGRESS_START = 0;
APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_SECRET = 4;
APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_PRIMARY = 5;
APIClient.CREATE_WALLET_PROGRESS_ENCRYPT_RECOVERY = 6;
APIClient.CREATE_WALLET_PROGRESS_PRIMARY = 10;
APIClient.CREATE_WALLET_PROGRESS_BACKUP = 20;
APIClient.CREATE_WALLET_PROGRESS_SUBMIT = 30;
APIClient.CREATE_WALLET_PROGRESS_INIT = 40;
APIClient.CREATE_WALLET_PROGRESS_DONE = 100;

/**
 * create a new wallet
 *   - will generate a new primary seed and backup seed
 *
 * Either takes two argument:
 * @param options       object      {}
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * For v1 wallets (explicitly specify options.walletVersion=v1):
 * @param options       object      {}
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 *
 * Or takes four arguments (old, deprecated syntax):
 * @param identifier    string      the wallet identifier to be initialized
 * @param passphrase    string      the password to decrypt the mnemonic with
 * @param keyIndex      int         override for the blocktrail cosign key to use (for development purposes)
 * @param [cb]          function    callback(err, wallet, primaryMnemonic, backupMnemonic, blocktrailPubKeys)
 * @returns {q.Promise}
 */
APIClient.prototype.createNewWallet = function(options, cb) {
    /* jshint -W071, -W074 */

    var self = this;

    if (typeof options !== "object") {
        // get the old-style arguments
        var identifier = arguments[0];
        var passphrase = arguments[1];
        var keyIndex = arguments[2];
        cb = arguments[3];

        // keyIndex is optional
        if (typeof keyIndex === "function") {
            cb = keyIndex;
            keyIndex = null;
        }

        options = {
            identifier: identifier,
            passphrase: passphrase,
            keyIndex: keyIndex
        };
    }

    // default to v3
    options.walletVersion = options.walletVersion || Wallet.WALLET_VERSION_V3;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    q.nextTick(function() {
        deferred.notify(APIClient.CREATE_WALLET_PROGRESS_START);

        options.keyIndex = options.keyIndex || 0;
        options.passphrase = options.passphrase || options.password;
        delete options.password;

        if (!options.identifier) {
            deferred.reject(new blocktrail.WalletCreateError("Identifier is required"));
            return deferred.promise;
        }

        if (options.walletVersion === Wallet.WALLET_VERSION_V1) {
            self._createNewWalletV1(options)
                .progress(function(p) { deferred.notify(p); })
                .then(function(r) { deferred.resolve(r); }, function(e) { deferred.reject(e); })
            ;
        } else if (options.walletVersion === Wallet.WALLET_VERSION_V2) {
            self._createNewWalletV2(options)
                .progress(function(p) { deferred.notify(p); })
                .then(function(r) { deferred.resolve(r); }, function(e) { deferred.reject(e); })
            ;
        } else if (options.walletVersion === Wallet.WALLET_VERSION_V3) {
            self._createNewWalletV3(options)
                .progress(function(p) { deferred.notify(p); })
                .then(function(r) { deferred.resolve(r); }, function(e) { deferred.reject(e); })
            ;
        } else {
            deferred.reject(new blocktrail.WalletCreateError("Invalid wallet version!"));
        }
    });

    return deferred.promise;
};

APIClient.prototype._createNewWalletV1 = function(options) {
    var self = this;

    var deferred = q.defer();

    q.nextTick(function() {

        if (!options.primaryMnemonic && !options.primarySeed) {
            if (!options.passphrase && !options.password) {
                deferred.reject(new blocktrail.WalletCreateError("Can't generate Primary Mnemonic without a passphrase"));
                return deferred.promise;
            } else {
                options.primaryMnemonic = bip39.generateMnemonic(Wallet.WALLET_ENTROPY_BITS);
                if (options.storePrimaryMnemonic !== false) {
                    options.storePrimaryMnemonic = true;
                }
            }
        }

        if (!options.backupMnemonic && !options.backupPublicKey) {
            options.backupMnemonic = bip39.generateMnemonic(Wallet.WALLET_ENTROPY_BITS);
        }

        deferred.notify(APIClient.CREATE_WALLET_PROGRESS_PRIMARY);

        self.resolvePrimaryPrivateKeyFromOptions(options)
            .then(function(options) {
                deferred.notify(APIClient.CREATE_WALLET_PROGRESS_BACKUP);

                return self.resolveBackupPublicKeyFromOptions(options)
                    .then(function(options) {
                        deferred.notify(APIClient.CREATE_WALLET_PROGRESS_SUBMIT);

                        // create a checksum of our private key which we'll later use to verify we used the right password
                        var pubKeyHash = bitcoin.crypto.hash160(options.primaryPrivateKey.getPublicKeyBuffer());
                        var checksum = bitcoin.address.toBase58Check(pubKeyHash, self.network.pubKeyHash);
                        var keyIndex = options.keyIndex;

                        var primaryPublicKey = options.primaryPrivateKey.deriveHardened(keyIndex).neutered();

                        // send the public keys to the server to store them
                        //  and the mnemonic, which is safe because it's useless without the password
                        return self.storeNewWalletV1(
                            options.identifier,
                            [primaryPublicKey.toBase58(), "M/" + keyIndex + "'"],
                            [options.backupPublicKey.toBase58(), "M"],
                            options.storePrimaryMnemonic ? options.primaryMnemonic : false,
                            checksum,
                            keyIndex,
                            options.segwit || null
                        )
                            .then(function(result) {
                                deferred.notify(APIClient.CREATE_WALLET_PROGRESS_INIT);

                                var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
                                    return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
                                });

                                var wallet = new Wallet(
                                    self,
                                    options.identifier,
                                    Wallet.WALLET_VERSION_V1,
                                    options.primaryMnemonic,
                                    null,
                                    null,
                                    {keyIndex: primaryPublicKey},
                                    options.backupPublicKey,
                                    blocktrailPublicKeys,
                                    keyIndex,
                                    result.segwit || 0,
                                    self.testnet,
                                    self.regtest,
                                    checksum,
                                    result.upgrade_key_index,
                                    options.useCashAddress,
                                    options.bypassNewAddressCheck
                                );

                                return wallet.unlock({
                                    walletVersion: Wallet.WALLET_VERSION_V1,
                                    passphrase: options.passphrase,
                                    primarySeed: options.primarySeed,
                                    primaryMnemonic: null // explicit null
                                }).then(function() {
                                    deferred.notify(APIClient.CREATE_WALLET_PROGRESS_DONE);
                                    return [
                                        wallet,
                                        {
                                            walletVersion: wallet.walletVersion,
                                            primaryMnemonic: options.primaryMnemonic,
                                            backupMnemonic: options.backupMnemonic,
                                            blocktrailPublicKeys: blocktrailPublicKeys
                                        }
                                    ];
                                });
                            });
                    }
                );
            })
            .then(
            function(r) {
                deferred.resolve(r);
            },
            function(e) {
                deferred.reject(e);
            }
        )
        ;
    });

    return deferred.promise;
};

APIClient.prototype._createNewWalletV2 = function(options) {
    var self = this;

    var deferred = q.defer();

    // avoid modifying passed options
    options = _.merge({}, options);

    determineDataStorageV2_3(options)
        .then(function(options) {
            options.passphrase = options.passphrase || options.password;
            delete options.password;

            // avoid deprecated options
            if (options.primaryPrivateKey) {
                throw new blocktrail.WalletInitError("Can't specify; Primary PrivateKey");
            }

            // seed should be provided or generated
            options.primarySeed = options.primarySeed || randomBytes(Wallet.WALLET_ENTROPY_BITS / 8);

            return options;
        })
        .then(function(options) {
            return produceEncryptedDataV2(options, deferred.notify.bind(deferred));
        })
        .then(function(options) {
            return doRemainingWalletDataV2_3(options, self.network, deferred.notify.bind(deferred));
        })
        .then(function(options) {
            // create a checksum of our private key which we'll later use to verify we used the right password
            var pubKeyHash = bitcoin.crypto.hash160(options.primaryPrivateKey.getPublicKeyBuffer());
            var checksum = bitcoin.address.toBase58Check(pubKeyHash, self.network.pubKeyHash);
            var keyIndex = options.keyIndex;

            // send the public keys and encrypted data to server
            return self.storeNewWalletV2(
                options.identifier,
                [options.primaryPublicKey.toBase58(), "M/" + keyIndex + "'"],
                [options.backupPublicKey.toBase58(), "M"],
                options.storeDataOnServer ? options.encryptedPrimarySeed : false,
                options.storeDataOnServer ? options.encryptedSecret : false,
                options.storeDataOnServer ? options.recoverySecret : false,
                checksum,
                keyIndex,
                options.support_secret || null,
                options.segwit || null
            )
                .then(
                function(result) {
                    deferred.notify(APIClient.CREATE_WALLET_PROGRESS_INIT);

                    var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
                        return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
                    });

                    var wallet = new Wallet(
                        self,
                        options.identifier,
                        Wallet.WALLET_VERSION_V2,
                        null,
                        options.storeDataOnServer ? options.encryptedPrimarySeed : null,
                        options.storeDataOnServer ? options.encryptedSecret : null,
                        {keyIndex: options.primaryPublicKey},
                        options.backupPublicKey,
                        blocktrailPublicKeys,
                        keyIndex,
                        result.segwit || 0,
                        self.testnet,
                        self.regtest,
                        checksum,
                        result.upgrade_key_index,
                        options.useCashAddress,
                        options.bypassNewAddressCheck
                    );

                    // pass along decrypted data to avoid extra work
                    return wallet.unlock({
                        walletVersion: Wallet.WALLET_VERSION_V2,
                        passphrase: options.passphrase,
                        primarySeed: options.primarySeed,
                        secret: options.secret
                    }).then(function() {
                        deferred.notify(APIClient.CREATE_WALLET_PROGRESS_DONE);
                        return [
                            wallet,
                            {
                                walletVersion: wallet.walletVersion,
                                encryptedPrimarySeed: options.encryptedPrimarySeed ?
                                    bip39.entropyToMnemonic(blocktrail.convert(options.encryptedPrimarySeed, 'base64', 'hex')) :
                                    null,
                                backupSeed: options.backupSeed ? bip39.entropyToMnemonic(options.backupSeed.toString('hex')) : null,
                                recoveryEncryptedSecret: options.recoveryEncryptedSecret ?
                                    bip39.entropyToMnemonic(blocktrail.convert(options.recoveryEncryptedSecret, 'base64', 'hex')) :
                                    null,
                                encryptedSecret: options.encryptedSecret ?
                                    bip39.entropyToMnemonic(blocktrail.convert(options.encryptedSecret, 'base64', 'hex')) :
                                    null,
                                blocktrailPublicKeys: blocktrailPublicKeys
                            }
                        ];
                    });
                }
            );
        })
       .then(function(r) { deferred.resolve(r); }, function(e) { deferred.reject(e); });

    return deferred.promise;
};

APIClient.prototype._createNewWalletV3 = function(options) {
    var self = this;

    var deferred = q.defer();

    // avoid modifying passed options
    options = _.merge({}, options);

    determineDataStorageV2_3(options)
        .then(function(options) {
            options.passphrase = options.passphrase || options.password;
            delete options.password;

            // avoid deprecated options
            if (options.primaryPrivateKey) {
                throw new blocktrail.WalletInitError("Can't specify; Primary PrivateKey");
            }

            // seed should be provided or generated
            options.primarySeed = options.primarySeed || randomBytes(Wallet.WALLET_ENTROPY_BITS / 8);

            return options;
        })
        .then(function(options) {
            return self.produceEncryptedDataV3(options, deferred.notify.bind(deferred));
        })
        .then(function(options) {
            return doRemainingWalletDataV2_3(options, self.network, deferred.notify.bind(deferred));
        })
        .then(function(options) {
            // create a checksum of our private key which we'll later use to verify we used the right password
            var pubKeyHash = bitcoin.crypto.hash160(options.primaryPrivateKey.getPublicKeyBuffer());
            var checksum = bitcoin.address.toBase58Check(pubKeyHash, self.network.pubKeyHash);
            var keyIndex = options.keyIndex;

            // send the public keys and encrypted data to server
            return self.storeNewWalletV3(
                options.identifier,
                [options.primaryPublicKey.toBase58(), "M/" + keyIndex + "'"],
                [options.backupPublicKey.toBase58(), "M"],
                options.storeDataOnServer ? options.encryptedPrimarySeed : false,
                options.storeDataOnServer ? options.encryptedSecret : false,
                options.storeDataOnServer ? options.recoverySecret : false,
                checksum,
                keyIndex,
                options.support_secret || null,
                options.segwit || null
            )
                .then(
                    // result, deferred, self(apiclient)
                    function(result) {
                        deferred.notify(APIClient.CREATE_WALLET_PROGRESS_INIT);

                        var blocktrailPublicKeys = _.mapValues(result.blocktrail_public_keys, function(blocktrailPublicKey) {
                            return bitcoin.HDNode.fromBase58(blocktrailPublicKey[0], self.network);
                        });

                        var wallet = new Wallet(
                            self,
                            options.identifier,
                            Wallet.WALLET_VERSION_V3,
                            null,
                            options.storeDataOnServer ? options.encryptedPrimarySeed : null,
                            options.storeDataOnServer ? options.encryptedSecret : null,
                            {keyIndex: options.primaryPublicKey},
                            options.backupPublicKey,
                            blocktrailPublicKeys,
                            keyIndex,
                            result.segwit || 0,
                            self.testnet,
                            self.regtest,
                            checksum,
                            result.upgrade_key_index,
                            options.useCashAddress,
                            options.bypassNewAddressCheck
                        );

                        // pass along decrypted data to avoid extra work
                        return wallet.unlock({
                            walletVersion: Wallet.WALLET_VERSION_V3,
                            passphrase: options.passphrase,
                            primarySeed: options.primarySeed,
                            secret: options.secret
                        }).then(function() {
                            deferred.notify(APIClient.CREATE_WALLET_PROGRESS_DONE);
                            return [
                                wallet,
                                {
                                    walletVersion: wallet.walletVersion,
                                    encryptedPrimarySeed: options.encryptedPrimarySeed ? EncryptionMnemonic.encode(options.encryptedPrimarySeed) : null,
                                    backupSeed: options.backupSeed ? bip39.entropyToMnemonic(options.backupSeed) : null,
                                    recoveryEncryptedSecret: options.recoveryEncryptedSecret ?
                                        EncryptionMnemonic.encode(options.recoveryEncryptedSecret) : null,
                                    encryptedSecret: options.encryptedSecret ? EncryptionMnemonic.encode(options.encryptedSecret) : null,
                                    blocktrailPublicKeys: blocktrailPublicKeys
                                }
                            ];
                        });
                    }
                );
        })
        .then(function(r) { deferred.resolve(r); }, function(e) { deferred.reject(e); });

    return deferred.promise;
};

function verifyPublicBip32Key(bip32Key, network) {
    var hk = bitcoin.HDNode.fromBase58(bip32Key[0], network);
    if (typeof hk.keyPair.d !== "undefined") {
        throw new Error('BIP32Key contained private key material - abort');
    }

    if (bip32Key[1].slice(0, 1) !== "M") {
        throw new Error("BIP32Key contained non-public path - abort");
    }
}

function verifyPublicOnly(walletData, network) {
    verifyPublicBip32Key(walletData.primary_public_key, network);
    verifyPublicBip32Key(walletData.backup_public_key, network);
}

/**
 * create wallet using the API
 *
 * @param identifier            string      the wallet identifier to create
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param backupPublicKey       array       the backup public key - [key, path] should be M/<keyIndex>'
 * @param primaryMnemonic       string      mnemonic to store
 * @param checksum              string      checksum to store
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param segwit                bool
 * @returns {q.Promise}
 */
APIClient.prototype.storeNewWalletV1 = function(identifier, primaryPublicKey, backupPublicKey, primaryMnemonic,
                                                checksum, keyIndex, segwit) {
    var self = this;

    var postData = {
        identifier: identifier,
        wallet_version: Wallet.WALLET_VERSION_V1,
        primary_public_key: primaryPublicKey,
        backup_public_key: backupPublicKey,
        primary_mnemonic: primaryMnemonic,
        checksum: checksum,
        key_index: keyIndex,
        segwit: segwit
    };

    verifyPublicOnly(postData, self.network);

    return self.blocktrailClient.post("/wallet", null, postData);
};

/**
 * create wallet using the API
 *
 * @param identifier            string      the wallet identifier to create
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param backupPublicKey       array       the backup public key - [key, path] should be M/<keyIndex>'
 * @param encryptedPrimarySeed  string      openssl format
 * @param encryptedSecret       string      openssl format
 * @param recoverySecret        string      openssl format
 * @param checksum              string      checksum to store
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param supportSecret         string
 * @param segwit                bool
 * @returns {q.Promise}
 */
APIClient.prototype.storeNewWalletV2 = function(identifier, primaryPublicKey, backupPublicKey, encryptedPrimarySeed, encryptedSecret,
                                                recoverySecret, checksum, keyIndex, supportSecret, segwit) {
    var self = this;

    var postData = {
        identifier: identifier,
        wallet_version: Wallet.WALLET_VERSION_V2,
        primary_public_key: primaryPublicKey,
        backup_public_key: backupPublicKey,
        encrypted_primary_seed: encryptedPrimarySeed,
        encrypted_secret: encryptedSecret,
        recovery_secret: recoverySecret,
        checksum: checksum,
        key_index: keyIndex,
        support_secret: supportSecret || null,
        segwit: segwit
    };

    verifyPublicOnly(postData, self.network);

    return self.blocktrailClient.post("/wallet", null, postData);
};

/**
 * create wallet using the API
 *
 * @param identifier            string      the wallet identifier to create
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param backupPublicKey       array       the backup public key - [key, path] should be M/<keyIndex>'
 * @param encryptedPrimarySeed  Buffer      buffer of ciphertext
 * @param encryptedSecret       Buffer      buffer of ciphertext
 * @param recoverySecret        Buffer      buffer of recovery secret
 * @param checksum              string      checksum to store
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param supportSecret         string
 * @param segwit                bool
 * @returns {q.Promise}
 */
APIClient.prototype.storeNewWalletV3 = function(identifier, primaryPublicKey, backupPublicKey, encryptedPrimarySeed, encryptedSecret,
                                                recoverySecret, checksum, keyIndex, supportSecret, segwit) {
    var self = this;

    var postData = {
        identifier: identifier,
        wallet_version: Wallet.WALLET_VERSION_V3,
        primary_public_key: primaryPublicKey,
        backup_public_key: backupPublicKey,
        encrypted_primary_seed: encryptedPrimarySeed.toString('base64'),
        encrypted_secret: encryptedSecret.toString('base64'),
        recovery_secret: recoverySecret.toString('hex'),
        checksum: checksum,
        key_index: keyIndex,
        support_secret: supportSecret || null,
        segwit: segwit
    };

    verifyPublicOnly(postData, self.network);

    return self.blocktrailClient.post("/wallet", null, postData);
};

/**
 * create wallet using the API
 *
 * @param identifier            string      the wallet identifier to create
 * @param postData              object
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.updateWallet = function(identifier, postData, cb) {
    var self = this;

    return self.blocktrailClient.post("/wallet/" + identifier, null, postData, cb);
};

/**
 * upgrade wallet to use a new account number
 *  the account number specifies which blocktrail cosigning key is used
 *
 * @param identifier            string      the wallet identifier
 * @param primaryPublicKey      array       the primary public key - [key, path] should be M/<keyIndex>'
 * @param keyIndex              int         keyIndex that was used to create wallet
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.upgradeKeyIndex = function(identifier, keyIndex, primaryPublicKey, cb) {
    var self = this;

    return self.blocktrailClient.post("/wallet/" + identifier + "/upgrade", null, {
        key_index: keyIndex,
        primary_public_key: primaryPublicKey
    }, cb);
};

/**
 * get the balance for the wallet
 *
 * @param identifier            string      the wallet identifier
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.getWalletBalance = function(identifier, cb) {
    var self = this;

    return self.blocktrailClient.get("/wallet/" + identifier + "/balance", null, true, cb);
};

/**
 * do HD wallet discovery for the wallet
 *
 * @param identifier            string      the wallet identifier
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.doWalletDiscovery = function(identifier, gap, cb) {
    var self = this;

    return self.blocktrailClient.get("/wallet/" + identifier + "/discovery", {gap: gap}, true, cb);
};


/**
 * get a new derivation number for specified parent path
 *  eg; m/44'/1'/0/0 results in m/44'/1'/0/0/0 and next time in m/44'/1'/0/0/1 and next time in m/44'/1'/0/0/2
 *
 * @param identifier            string      the wallet identifier
 * @param path                  string      the parent path for which to get a new derivation,
 *                                           can be suffixed with /* to make it clear on which level the derivations hould be
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.getNewDerivation = function(identifier, path, cb) {
    var self = this;

    return self.blocktrailClient.post("/wallet/" + identifier + "/path", null, {path: path}, cb);
};


/**
 * delete the wallet
 *  the checksum address and a signature to verify you ownership of the key of that checksum address
 *  is required to be able to delete a wallet
 *
 * @param identifier            string      the wallet identifier
 * @param checksumAddress       string      the address for your master private key (and the checksum used when creating the wallet)
 * @param checksumSignature     string      a signature of the checksum address as message signed by the private key matching that address
 * @param [force]               bool        ignore warnings (such as a non-zero balance)
 * @param [cb]                  function    callback(err, result)
 * @returns {q.Promise}
 */
APIClient.prototype.deleteWallet = function(identifier, checksumAddress, checksumSignature, force, cb) {
    var self = this;

    if (typeof force === "function") {
        cb = force;
        force = false;
    }

    return self.blocktrailClient.delete("/wallet/" + identifier, {force: force}, {
        checksum: checksumAddress,
        signature: checksumSignature
    }, cb);
};

/**
 * use the API to get the best inputs to use based on the outputs
 *
 * the return array has the following format:
 * [
 *  "utxos" => [
 *      [
 *          "hash" => "<txHash>",
 *          "idx" => "<index of the output of that <txHash>",
 *          "scriptpubkey_hex" => "<scriptPubKey-hex>",
 *          "value" => 32746327,
 *          "address" => "1address",
 *          "path" => "m/44'/1'/0'/0/13",
 *          "redeem_script" => "<redeemScript-hex>",
 *      ],
 *  ],
 *  "fee"   => 10000,
 *  "change"=> 1010109201,
 * ]
 *
 * @param identifier        string      the wallet identifier
 * @param pay               array       {'address': (int)value}     coins to send
 * @param lockUTXO          bool        lock UTXOs for a few seconds to allow for transaction to be created
 * @param allowZeroConf     bool        allow zero confirmation unspent outputs to be used in coin selection
 * @param feeStrategy       string      defaults to
 * @param options
 * @param [cb]              function    callback(err, utxos, fee, change)
 * @returns {q.Promise}
 */
APIClient.prototype.coinSelection = function(identifier, pay, lockUTXO, allowZeroConf, feeStrategy, options, cb) {
    var self = this;

    if (typeof feeStrategy === "function") {
        cb = feeStrategy;
        feeStrategy = null;
        options = {};
    } else if (typeof options === "function") {
        cb = options;
        options = {};
    }

    feeStrategy = feeStrategy || Wallet.FEE_STRATEGY_OPTIMAL;
    options = options || {};

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    var params = {
        lock: lockUTXO,
        zeroconf: allowZeroConf ? 1 : 0,
        zeroconfself: (typeof options.allowZeroConfSelf !== "undefined" ? options.allowZeroConfSelf : true) ? 1 : 0,
        fee_strategy: feeStrategy
    };

    if (options.forcefee) {
        params['forcefee'] = options.forcefee;
    }

    deferred.resolve(
        self.blocktrailClient.post("/wallet/" + identifier + "/coin-selection", params, pay).then(
            function(result) {
                return [result.utxos, result.fee, result.change, result];
            },
            function(err) {
                if (err.message.match(/too low to pay the fee/)) {
                    throw blocktrail.WalletFeeError(err);
                }

                throw err;
            }
        )
    );

    return deferred.promise;
};

/**
 * @param [cb]              function    callback(err, utxos, fee, change)
 * @returns {q.Promise}
 */
APIClient.prototype.feePerKB = function(cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.spreadNodeify(cb);

    deferred.resolve(self.blocktrailClient.get("/fee-per-kb"));

    return deferred.promise;
};

/**
 * send the transaction using the API
 *
 * @param identifier        string      the wallet identifier
 * @param txHex             string      partially signed transaction as hex string
 * @param paths             array       list of paths used in inputs which should be cosigned by the API
 * @param checkFee          bool        when TRUE the API will verify if the fee is 100% correct and otherwise throw an exception
 * @param [twoFactorToken]  string      2FA token
 * @param [prioboost]       bool
 * @param options           object      Additional options (for Bitpay/BCH right now)
 * @param [cb]              function    callback(err, txHash)
 * @returns {q.Promise}
 */
APIClient.prototype.sendTransaction = function(identifier, txHex, paths, checkFee, twoFactorToken, prioboost, options, cb) {
    var self = this;

    if (typeof twoFactorToken === "function") {
        cb = twoFactorToken;
        twoFactorToken = null;
        prioboost = false;
    } else if (typeof prioboost === "function") {
        cb = prioboost;
        prioboost = false;
    } else if (typeof options === "function") {
        cb = options;
        options = {};
    }

    var data = {
        paths: paths,
        two_factor_token: twoFactorToken
    };
    if (typeof txHex === "string") {
        data.raw_transaction = txHex;
    } else if (typeof txHex === "object") {
        Object.keys(txHex).map(function(key) {
            data[key] = txHex[key];
        });
    }

    var postOptions = {
        check_fee: checkFee ? 1 : 0,
        prioboost: prioboost ? 1 : 0
    };

    var bip70 = false;
    if (options.bip70PaymentUrl) {
        bip70 = true;
        postOptions.bip70PaymentUrl = options.bip70PaymentUrl;

        if (options.bip70MerchantData && options.bip70MerchantData instanceof Uint8Array) {
            // Encode merchant data to base64
            var decoder = new TextDecoder('utf8');
            var bip70MerchantData = btoa(decoder.decode(options.bip70MerchantData));

            postOptions.bip70MerchantData = bip70MerchantData;
        }
    }

    return self.blocktrailClient.post(
        "/wallet/" + identifier + "/send",
        postOptions,
        data,
        cb
    );
};

/**
 * setup a webhook for this wallet
 *
 * @param identifier        string      the wallet identifier
 * @param webhookIdentifier string      identifier for the webhook
 * @param url               string      URL to receive webhook events
 * @param [cb]              function    callback(err, webhook)
 * @returns {q.Promise}
 */
APIClient.prototype.setupWalletWebhook = function(identifier, webhookIdentifier, url, cb) {
    var self = this;

    return self.blocktrailClient.post("/wallet/" + identifier + "/webhook", null, {url: url, identifier: webhookIdentifier}, cb);
};

/**
 * delete a webhook that was created for this wallet
 *
 * @param identifier        string      the wallet identifier
 * @param webhookIdentifier string      identifier for the webhook
 * @param [cb]              function    callback(err, success)
 * @returns {q.Promise}
 */
APIClient.prototype.deleteWalletWebhook = function(identifier, webhookIdentifier, cb) {
    var self = this;

    return self.blocktrailClient.delete("/wallet/" + identifier + "/webhook/" + webhookIdentifier, null, null, cb);
};

/**
 * get all transactions for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletTransactions = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/wallet/" + identifier + "/transactions", params, true, cb);
};

/**
 * get all addresses for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletAddresses = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/wallet/" + identifier + "/addresses", params, true, cb);
};

/**
 * @param identifier    string      wallet identifier
 * @param address       string      the address to label
 * @param label         string      the label
 * @param [cb]          function    callback(err, res)
 * @return q.Promise
 */
APIClient.prototype.labelWalletAddress = function(identifier, address, label, cb) {
    var self = this;

    return self.blocktrailClient.post("/wallet/" + identifier + "/address/" + address + "/label", null, {label: label}, cb);
};

APIClient.prototype.walletMaxSpendable = function(identifier, allowZeroConf, feeStrategy, options, cb) {
    var self = this;

    if (typeof feeStrategy === "function") {
        cb = feeStrategy;
        feeStrategy = null;
    } else if (typeof options === "function") {
        cb = options;
        options = {};
    }

    feeStrategy = feeStrategy || Wallet.FEE_STRATEGY_OPTIMAL;
    options = options || {};

    var params = {
        outputs: options.outputs ? options.outputs : 1,
        zeroconf: allowZeroConf ? 1 : 0,
        zeroconfself: (typeof options.allowZeroConfSelf !== "undefined" ? options.allowZeroConfSelf : true) ? 1 : 0,
        fee_strategy: feeStrategy
    };

    if (options.forcefee) {
        params['forcefee'] = options.forcefee;
    }

    return self.blocktrailClient.get("/wallet/" + identifier + "/max-spendable", params, true, cb);
};

/**
 * get all UTXOs for an wallet (paginated)
 *
 * @param identifier    string      wallet identifier
 * @param [params]      object      pagination: {page: 1, limit: 20, sort_dir: 'asc'}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.walletUTXOs = function(identifier, params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/wallet/" + identifier + "/utxos", params, true, cb);
};

/**
 * get a paginated list of all wallets associated with the api user
 *
 * @param [params]      object      pagination: {page: 1, limit: 20}
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.allWallets = function(params, cb) {
    var self = this;

    if (typeof params === "function") {
        cb = params;
        params = null;
    }

    return self.blocktrailClient.get("/wallets", params, true, cb);
};

/**
 * verify a message signed bitcoin-core style
 *
 * @param message        string
 * @param address        string
 * @param signature      string
 * @param [cb]          function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.verifyMessage = function(message, address, signature, cb) {
    var self = this;

    var deferred = q.defer();
    deferred.promise.nodeify(cb);
    try {
        var result = bitcoinMessage.verify(address, self.network.messagePrefix, message, new Buffer(signature, 'base64'));
        deferred.resolve(result);
    } catch (e) {
        deferred.reject(e);
    }

    return deferred.promise;
};

/**
 * max is 0.001
 * testnet only
 *
 * @param address
 * @param amount
 * @param cb
 */
APIClient.prototype.faucetWithdrawl = function(address, amount, cb) {
    var self = this;

    return self.blocktrailClient.post("/faucet/withdrawl", null, {address: address, amount: amount}, cb);
};

/**
 * send a raw transaction
 *
 * @param rawTransaction    string      raw transaction as HEX
 * @param [cb]              function    callback function to call when request is complete
 * @return q.Promise
 */
APIClient.prototype.sendRawTransaction = function(rawTransaction, cb) {
    var self = this;

    return self.blocktrailClient.post("/send-raw-tx", null, rawTransaction, cb);
};

/**
 * get the current price index
 *
 * @param [cb]          function    callback({'USD': 287.30})
 * @return q.Promise
 */
APIClient.prototype.price = function(cb) {
    var self = this;

    return self.blocktrailClient.get("/price", null, false, cb);
};

module.exports = APIClient;
