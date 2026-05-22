export default class SiteConfigEndpoint {
  name = "Site Config endpoint";

  constructor(options = {}) {
    this.options = { mountPath: "/site-config", ...options };
    this.mountPath = this.options.mountPath;
  }
}
