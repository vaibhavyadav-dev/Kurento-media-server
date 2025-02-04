const express = require('express');
const app = express();
let http = require('http').Server(app);
let minimist = require('minimist');
let io = require('socket.io')(http);
const kurento = require('kurento-client');

let kurentoClient = null;
let iceCandidateQueues = {};


let argv = minimist(process.argv.slice(2), {
    default: {
        //application server
        as_uri: 'http://localhost:3000',
        //web socket
        ws_uri: 'ws://localhost:8888/kurento'
    }
})

io.on('connection', socket => {
    console.log("socket client created!")
    socket.on('message', message => {
        console.log("line 24", message);
        switch (message.event) {
            case 'joinRoom':
                joinRoom(socket, message.userName, message.roomName, err => {
                    if (err) {
                        console.log(err);
                    }
                });
                break;
            case 'receiveVideoFrom':
                receiveVideoFrom(socket, message.userId, message.roomName, message.sdpOffer, err => {
                    if (err) {
                        console.log(err);
                    }
                })
                break;
            case 'candidate':
                addIceCandidate(socket, message.userid, message.roomName, message.candidate, err => {
                    if (err) {
                        console.log(err);
                    }
                })
                break;
        }
    })
})

function joinRoom(socket, username, roomname, callback) {
    console.log("joinRoomHandler");
    getRoom(socket, roomname, async (err, myRoom) => {
        if (err) {
            console.log("joinRoom():", err);
            return callback(err);
        }

        try {
            let outgoingMedia = await myRoom.pipeline.create('WebRtcEndpoint');
            let user = {
                id: socket.id,
                name: username,
                outgoingMedia: outgoingMedia,
                incomingMedia: {}
            }


            let icecandidateQueue = iceCandidateQueues[user.id];
            if (icecandidateQueue) {
                while (icecandidateQueue.length) {
                    let ice = icecandidateQueue.shift();
                    user.outgoingMedia.addIceCandidate(ice.candidate);
                }
            }

            user.outgoingMedia.on('IceCandidateFound', (event) => {
                if (event.candidate) {
                    socket.emit('message', {
                        event: 'candidate',
                        userid: user.id,
                        candidate: event.candidate
                    })
                }
            })

            socket.to(roomname).emit('message', {
                event: 'newParticipantArrived',
                userid: user.id,
                username: user.name
            })

            let existingUsers = [];
            for (let i in myRoom.participants) {
                if (myRoom.participants[i].id !== user.id) {
                    existingUsers.push({
                        id: myRoom.participants[i].id,
                        name: myRoom.participants[i].name
                    })
                }
            }
            console.log("existingParticipants", existingUsers)
            socket.emit('message', {
                event: 'existingParticipants',
                existingUsers,
                userid: user.id
            })
            myRoom.participants[user.id] = user;
        } catch (err) {
            console.log("Error occured while creating WebRtcEndpoint")
            return callback(err);
        }
    })
}

async function getKurentoClient(callback) {
    if (kurentoClient !== null)
        return null;
    try {
        kurentoClient = await kurento(argv.ws_uri);
        return null;
    } catch (error) {
        console.log("Error Occured while creating Kurento Client");
        return error;
    }
}

async function getRoom(socket, roomname, callback) {
    let myRoom = io.sockets.adapter.rooms.get(roomname) || { length: 0 };
    let numClients = myRoom.length;
    if (numClients === 0) {
        console.log("// creates room for 1st user")
        socket.join(roomname);
        myRoom = io.sockets.adapter.rooms.get(roomname);
        try {
            let err = await getKurentoClient();
            if (err) {
                console.log("Get Kurento Client", err);
            } else {
                myRoom.pipeline = await kurentoClient.create('MediaPipeline');
                myRoom.participants = {};
                callback(null, myRoom);
            }
        } catch (err) {
            console.log("error occured");
            console.log(err);
        }
    } else {
        socket.join(roomname);
        callback(null, myRoom);
    }
}

async function getEndpointForUser(socket, roomname, senderid, callback) {
    let myRoom = io.sockets.adapter.rooms.get(roomname);
    let asker = myRoom.participants[socket.id];
    let sender = myRoom.participants[senderid];

    if (asker.id === sender.id) {
        console.log("Asker.id==sender.id")
        return callback(null, asker.outgoingMedia);
    }
    if (asker.incomingMedia[sender.id]) {
        sender.outgoingMedia.connect(asker.incomingMedia[sender.id], err => {
            if (err) return callback(err)
            callback(null, asker.incomingMedia[sender.id])
        });

    } else {
        try {
            let incomingMedia = await myRoom.pipeline.create('WebRtcEndpoint');
            asker.incomingMedia[sender.id] = incomingMedia;

            let icecandidateQueue = iceCandidateQueues[sender.id];

            if (icecandidateQueue) {
                while (icecandidateQueue.length) {
                    let ice = icecandidateQueue.shift();
                    incomingMedia.addIceCandidate(ice.candidate);
                }
            }
            incomingMedia.on('IceCandidateFound', event => {
                if (event.candidate) {
                    socket.emit('message', {
                        event: 'candidate',
                        userid: sender.id,
                        candidate: event.candidate
                    })
                }
            })
            sender.outgoingMedia.connect(incomingMedia);
            return callback(null, incomingMedia);
        } catch (e) {
            console.log("Error occured while creating incoming media client.")
            return callback(e);
        }
    }
}

function receiveVideoFrom(socket, userid, roomName, sdpOffer, callback) {
    getEndpointForUser(socket, roomName, userid, async (err, endpoint) => {
        if (err) return callback(err);
        console.log("sdpOffStart");
        console.log("sdpOffEND");

        try {
            const answerSdp = await endpoint.processOffer(sdpOffer);
            socket.emit('message', {
                event: "receiveVideoAnswer",
                senderid: userid,
                sdpAnswer: answerSdp
            });

            endpoint.gatherCandidates(err => {
                if (err) return callback(err);
            })


        } catch (err) {
            console.log("Error Occured while processing offer");
            return callback(err)
        }
    })
}

function addIceCandidate(socket, senderid, roomName, iceCandidate, callback) {
    let myRoom = io.sockets.adapter.rooms.get(roomName)
    let user = myRoom ? myRoom.participants[socket.id] : null;

    if (user != null) {
        let candidate = kurento.register.complexTypes.IceCandidate(iceCandidate);
        if (senderid === user.id) {
            if (user.outgoingMedia) {
                user.outgoingMedia.addIceCandidate(candidate);
            } else {
                iceCandidateQueues[user.id].push({ candidate: candidate });
            }
        } else {
            if (user.incomingMedia[senderid]) {
                user.incomingMedia[senderid].addIceCandidate(candidate);
            } else {
                if (!iceCandidateQueues[senderid]) {
                    iceCandidateQueues[senderid] = [];
                }
                iceCandidateQueues[senderid].push({ candidate: candidate })
            }
        }
        callback(null);
    } else {
        callback(new Error("addIceCandidate failed"));
    }
}

app.use(express.static('public'));

http.listen(5000, () => {
    console.log('Express Server is Running....');
})