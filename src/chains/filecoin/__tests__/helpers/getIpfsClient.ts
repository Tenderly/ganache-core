import IpfsHttpClient from "ipfs-http-client";
import IPFSServer from "../../src/ipfsserver";

export default () => {
  return IpfsHttpClient({
    host: "localhost",
    port: 5002, // Use a different port than the default, for testing
    protocol: "http"
  });
}