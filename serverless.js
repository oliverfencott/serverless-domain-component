const { Component } = require('@serverless/core')
const {
  getClients,
  validateInputs,
  getHostedZoneIdByDomain,
  getCertificateArnByDomain,
  addDomainToApig
} = require('./new') // todo change this

// todo check input changes
class Domain extends Component {
  async default(inputs = {}) {
    this.context.status('Deploying')
    this.context.debug(`Validating domain.`)

    inputs = validateInputs(inputs)

    // Get AWS SDK Clients
    const clients = getClients(this.context.credentials.aws, inputs.region)

    // Get hosted zone id if the user didn't specify it
    if (!inputs.hostedZoneId) {
      this.context.debug(`Getting the Hosted Zone ID for the domain ${inputs.domain}.`)
      inputs.hostedZoneId = await getHostedZoneIdByDomain(clients, inputs)
    }

    // Get certificate arn and validate if necessary
    this.context.debug(
      `Searching for an AWS ACM Certificate based on the domain: ${inputs.domain}.`
    )
    inputs.certificateArn = await getCertificateArnByDomain(clients, inputs, this.context)

    // Setting up domains for different services
    for (const subdomain of inputs.subdomains) {
      if (subdomain.type === 'awsApiGateway') {
        this.context.debug(`Adding ${subdomain.name} domain to API with URL "${subdomain.url}"`)
        // Map APIG domain to API ID and recursively retry
        // if APIG domain need to be created first, or TooManyRequests error is thrown
        await addDomainToApig(
          clients,
          subdomain,
          inputs.hostedZoneId,
          inputs.certificateArn,
          this.context
        )
      }
    }

    const outputs = {
      region: inputs.region
    }

    outputs.domains = inputs.subdomains.map(
      (subdomain) => `https://${subdomain.name.replace('www.', '')}`
    )

    return outputs
  }

  async remove() {
    this.context.status('Deploying')

    if (!this.state.domain) {
      return
    }

    this.context.debug(`Starting Domain component removal.`)

    // Get AWS SDK Clients
    const clients = getClients(this.context.credentials.aws, this.state.region)

    this.context.debug(`Getting the Hosted Zone ID for the domain ${this.state.domain}.`)
    const domainHostedZoneId = await getDomainHostedZoneId(
      clients.route53,
      this.state.domain,
      this.state.privateZone
    )

    for (const subdomain in this.state.subdomains) {
      const domainState = this.state.subdomains[subdomain]
      if (domainState.type === 'awsS3Website') {
        this.context.debug(
          `Fetching CloudFront distribution info for removal for domain ${domainState.domain}.`
        )
        const distribution = await getCloudFrontDistributionByDomain(clients.cf, domainState.domain)

        if (distribution) {
          this.context.debug(`Removing DNS records for website domain ${domainState.domain}.`)
          await removeCloudFrontDomainDnsRecords(
            clients.route53,
            domainState.domain,
            domainHostedZoneId,
            distribution.url
          )

          if (domainState.domain.startsWith('www')) {
            await removeCloudFrontDomainDnsRecords(
              clients.route53,
              domainState.domain.replace('www.', ''), // it'll move on if it doesn't exist
              domainHostedZoneId,
              distribution.url
            )
          }
        }
      } else if (domainState.type === 'awsApiGateway') {
        this.context.debug(
          `Fetching API Gateway domain ${domainState.domain} information for removal.`
        )
        const domainRes = await getApiDomainName(clients.apig, domainState.domain)

        if (domainRes) {
          this.context.debug(`Removing API Gateway domain ${domainState.domain}.`)
          await removeApiDomain(clients.apig, domainState.domain)

          this.context.debug(`Removing DNS records for API Gateway domain ${domainState.domain}.`)
          await removeApiDomainDnsRecords(
            clients.route53,
            domainState.domain,
            domainHostedZoneId,
            domainRes.distributionHostedZoneId,
            domainRes.distributionDomainName
          )
        }
      } else if (domainState.type === 'awsCloudFront') {
        this.context.debug(`Removing domain ${domainState.domain} from CloudFront.`)
        await removeDomainFromCloudFrontDistribution(clients.cf, domainState)

        this.context.debug(`Removing CloudFront DNS records for domain ${domainState.domain}`)
        await removeCloudFrontDomainDnsRecords(
          clients.route53,
          domainState.domain,
          domainHostedZoneId,
          domainState.url.replace('https://', '')
        )
      }
    }
    this.state = {}
    await this.save()
    return {}
  }
}

module.exports = Domain
