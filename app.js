"use strict";
require('console-stamp')(console, 'dd.mm HH:MM:ss.l'); // formats the console output
const express = require('express');
const bodyParser = require('body-parser');
//const fs = require('fs');
const WebsocketConnections = require('./websocketConnections');
const WebSocket = require('ws');
const url = require('url');
const http = require('http');

const responsesList = [];
var lastImpactResponse = {};
var wss;

console.log("version 1.0");
const port = process.env.PORT || process.env.port || process.env.OPENSHIFT_NODEJS_PORT || 8080;
const camera_port = process.env.CAMERA_PORT || process.env.camera_port || 8088;
const ip = process.env.OPENSHIFT_NODEJS_IP || process.argv[2] || '0.0.0.0';

const PASSWORD = process.env.WS_PASSWORD;
const camDataPath = "/camera";
const clientDataPath = "/client";
const camsInfoPath = '/cams';
const peoplePath = '/people_count';
const heatmapPath = '/heatmap';
const lastIpPath = '/ip';
const camConnections = new WebsocketConnections.CameraConnections();
const impactCallbackPath = '/m2m/impact/callback';
const oldIpAddressesObj = {};

/** http server: base */
const app = express();
const proxy = express();

app.use(logReq); // logging middleware
app.use(authorization); // basic authorization middleware
app.use('/cameras', proxy); // set proxy sub application
app.set('view engine', 'pug');

app.use(express.static('public'));
  
app.get(camsInfoPath, function(req, res){
    res.send({ cams: camConnections.getInfo(), count: camConnections.count()});
});
app.post(peoplePath, bodyParser.text(), function(req,res){
    checkCamera(req, res, function(camera) {
        camera.peopleCount = req.body;
        //fs.createWriteStream('people.txt').write(""+camera.peopleCount);//(test only)
    });
    res.end("ok");
});

app.get(peoplePath, function(req, res){
    checkCamera(req, res, function(camera){ res.send(''+camera.peopleCount); }); 
});

app.post(heatmapPath, bodyParser.raw({type:"image/png", limit:'500kb'}), function(req, res){
    if(req.get('Content-Type') != "image/png") {res.status(415).end("must be png image");}
    checkCamera(req, res, function(camera) {
            camera.heatmap = req.body;
            //fs.createWriteStream('pic'+new Date().getTime()+'.png').write(camera.heatmap);//create image (test only)
    });
    res.end("ok");
});

app.get(heatmapPath, function(req,res){
    checkCamera(req, res, function(camera){
        if(camera.heatmap) res.send(camera.heatmap);
        else res.status(400).send("no heatmap yet");
    });
});

app.get(lastIpPath, function(req, res){
    var cam = req.query.camera_name;
    var ip = oldIpAddressesObj[cam];
    if(ip) res.send(ip); else res.status(400).send("camera does not exist");
});

app.get("/statistics", function(req, res){
    var count = 0;
    if(wss){
        res.write("WebSocket Server clients: " + wss.clients.size + "\n");
    }
    // res.write("clients on blacklist: " + camConnections.getClientsOnBackList()+"\n");
    camConnections.cameras.forEach((val) => {
        var camera = val;
        res.write(count + "." + camera.name + " , " + camera.ip + ", clients: " + camera._clients.size);
        res.write(", Client errors: " + camera.clientErrors + "\n");
        count++;
    });
    res.status(200).end();
});

app.post(impactCallbackPath,bodyParser.text(), bodyParser.json(), function(req, res){
    // return something if not json. needed to register server
    if( req.headers['content-type'].search('application/json') ){
        res.status(200).end();
        return;
    }
    var data = req.body.responses;
    lastImpactResponse = data;
    if(!data){
        res.status(400).end();
        return;
    }else{
        data.forEach(element => {
            responsesList.push(element);
        });

    }
    // prevent memory leak by removing the oldest
    if(responsesList.length > 100){
        responsesList.shift();
    }
    res.status(200).end();
});

app.get('/responsesList', bodyParser.json(), (req, res) => res.status(200).json(responsesList));
app.get('/lastImpactResponse', bodyParser.json(), (req, res) => res.status(200).json(lastImpactResponse));
app.get(impactCallbackPath, bodyParser.json(), function(req, res){

    var requestId = req.query.requestId;
    var response = responsesList.find(x => x.requestId == requestId);
    if(response){
        // delete from the list
        var indx = responsesList.indexOf(response);
        responsesList.splice(indx, 1);
        res.status(200).send(response);
    }else{
        res.status(404).send("Did not find any response with such requestId");
    }
});



// sub-app which redirects http requests using the camera name
proxy.all('/:name/:resource', function(client_req, client_res){
    var resource = client_req.params.resource;
    var camera_name = client_req.params.name;
    checkCameraProxy(camera_name, client_res, function(camera){
        var strQuery = url.parse(client_req.url).search || ""; // search is the '?' plus the query
        var hostname = camera.ip;
        var options = {
            hostname: hostname,
            port:camera_port,
            path: "/"+resource + strQuery,
            method:client_req.method,
            headers: client_req.headers
        };          
        // forward response from camera to client
            var camera_req = http.request(options, function(cam_response){
                client_res.writeHead(cam_response.statusCode, cam_response.headers);
                cam_response.pipe(client_res);
            });
        
            camera_req.on('error', function(err){
                console.warn('some error on the camera request:%s', err);
                client_res.status(404).end();
            });

            // forward body from client data to camera
            client_req.pipe(camera_req, {end:true});
    });
});


const server = http.createServer(app);


/* MAIN entry point */
main(server);

/** @function
 *  @param {http.Server} server */
function main(server) {
     /** websocket server extends the http server */
    wss = new WebSocket.Server({
        verifyClient: verifyClient,
        server: server
        });

    console.log("running on %s:%d", ip, port);

    wss.on('connection', function connection(ws, upgradeReq) {
        var parsedUrl = url.parse(upgradeReq.url, true);
        var path = parsedUrl.pathname;
        var query = parsedUrl.query;
        var ip = getIpAddresses(upgradeReq);
        var camera_name;
        console.log("new WS %s, ip: %s", upgradeReq.url, ip);    

        switch (path) {
            case camDataPath:  // a camera wants to register
                camera_name = query.camera_name || undefined;
                var ipAddress = getIpAddresses(upgradeReq);
                camConnections.add(ws, camera_name, ipAddress);
                oldIpAddressesObj[camera_name] = ipAddress;
                break;
            case clientDataPath:  // a client wants to register to a camera
                camera_name = query.camera_name || "camera0";
                camConnections.addClientToCamera(camera_name, ws, function(err){
                    if(err){ws.terminate();}         
                });
                break;
            default:
                console.log("rejected: no valid path");
                ws.terminate();
                return;
        }
    });

    server.listen(port, ip);
}

function authorization(req, res, next){
    // NOTE: this requests an user and a password, it does not check it
    if(req.path == camsInfoPath) {next(); return;} // TODO: This is for compability, remove in the future

    var auth = req.headers.authorization;
    if(!auth){
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Unauthorized access fordbiden"');
        res.end('Provide user and password')
    }else{
        next();
    }
}


function verifyClient(info) {
    var acceptHandshake = false;
    var ip = info.req.connection.remoteAddress;
    
    var clientUrl = url.parse(info.req.url, true);
    var query = clientUrl.query;

    acceptHandshake = query.pass == PASSWORD;

    if (!acceptHandshake) {
        console.log("client rejected: no valid password, use 'pass' parameter in the handshake please");
    }
    return acceptHandshake;
}


function getIpAddresses(req){
    var ipAddress = req.headers['x-forwarded-for'] || 
        req.connection.remoteAddress || 
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;
    return ipAddress.match(/(\d+\.\d+\.\d+\.\d+)/)[0];
}

function logReq(req, res, next){
    console.log("%s %s %s",req.method, req.url, new Date().toString());
    next();
}

function checkCamera(req, res, next){
    if(!req.query.camera_name) res.status(400).end("provide camera name");

    camConnections.getCamera(req.query.camera_name, function(camera){
        if(!camera) {res.status(404).send("camera not found. Is it registered already?");}
        else{next(camera);}
    });
}

function checkCameraProxy(camera_name, res, next){
    if(!camera_name){ res.status(400).end("provide camera name");}

    camConnections.getCamera(camera_name, function(camera){
        if(!camera) {res.status(404).send("camera not found. Is it registered already?");}
        else{next(camera);}
    });
}