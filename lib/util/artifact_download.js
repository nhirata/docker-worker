import request from 'request';
import fs from 'mz/fs';
import sleep from '../util/sleep';
import { fmtLog, fmtErrorLog } from '../log';

const RETRY_CONFIG = {
  maxAttempts: 5,
  delayFactor: 15 * 1000,
  randomizationFactor: 0.25
};

/*
 * Downloads an artifact for a particular task and saves it locally.
 *
 * @param {Object} queue - Queue instance
 * @param {String} taskId - ID of the task
 * @param {String} artifactPath - Path to find the artifact for a given task
 * @param {String} destination - Path to store the file locally
 */
export default async function(queue, stream, taskId, artifactPath, destination, retryConfig=RETRY_CONFIG) {
  let {maxAttempts, delayFactor, randomizationFactor} = retryConfig;
  let artifactUrl = queue.buildSignedUrl(
      queue.getLatestArtifact,
      taskId,
      artifactPath
  );

  let attempts = 0;

  stream.write(
    fmtLog(`Downloading artifact "${artifactPath}" from task ID: ${taskId}.`)
  );
  while (attempts++ < maxAttempts) {
    let destinationStream = fs.createWriteStream(destination);
    try {
      let totalSize = 0;
      let receivedSize;
      let startTime = Date.now();
      let req = request.get(artifactUrl);
      req.on('response', (res) => {
        totalSize = res.headers['content-length'];
        receivedSize = 0;
      });
      req.on('data', (chunk) => {
        receivedSize += chunk.length;
      });

      let intervalId = setInterval(() => {
        if (receivedSize) {
          stream.write(fmtLog(
            `Download Progress: ${((receivedSize/totalSize)*100).toFixed(2)}%`
          ));
        }
      }, 5000);

      req.pipe(destinationStream);

      try {
        await new Promise((accept, reject) => {
          req.on('end', (res) => {
            clearInterval(intervalId);
            accept(res);
          });
          req.on('error', (err) => {
            clearInterval(intervalId);
            reject(err);
          });
        });
      } catch(e) {
        throw e;
      }

      if (req.response.statusCode !== 200) {
        let error = new Error(req.response.statusMessage);
        error.statusCode = req.response.statusCode;
        throw error;
      }

      stream.write(fmtLog('Downloaded artifact successfully.'));
      stream.write(fmtLog(
        `Downloaded ${(totalSize/1024/1024).toFixed(3)} mb ` +
        `in ${((Date.now() - startTime)/1000).toFixed(2)} seconds.`
      ));
      return;
    } catch(e) {
      if (attempts >= maxAttempts || [404, 401].includes(e.statusCode)) {
        throw new Error(
          `Could not download artifact "${artifactPath} from ` +
          `task "${taskId}" after ${attempts} attempt(s). Error: ${e.message}`
        );
      }

      // remove any partially downloaded file
      await fs.unlink(destination);

      let delay = Math.pow(2, attempts - 1) * delayFactor;
      let exponentialDelay = delay * (Math.random() * 2 * randomizationFactor + 1 - randomizationFactor);

      stream.write(fmtErrorLog(
        `Error downloading "${artifactPath}" from task ID "${taskId}". ` +
        `Next Attempt in: ${exponentialDelay.toFixed(2)} ms.`
      ));

      await sleep(exponentialDelay);
    }
  }
}

