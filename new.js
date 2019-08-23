const { utils } = require('@serverless/core')

const validateInputs = (inputs) => {
  inputs.region = inputs.region || 'us-east-1'
  inputs.privateZone = inputs.privateZone || false // todo remove

  if (typeof inputs.domain !== 'string' || inputs.domain.split('.') !== 2) {
    throw Error(`Invalid domain specified.`)
  }

  const subdomains = []

  for (const subdomainPart in inputs.subdomains || {}) {
    const componentOutputs = inputs.subdomains[subdomainPart]
    const subdomain = {
      name: `${subdomainPart}.${inputs.domain}`
    }

    // Check if referenced Component is using AWS API Gateway...
    if (componentOutputs.url.includes('execute-api')) {
      subdomain.type = 'awsApiGateway'
      subdomain.url = componentOutputs.url.replace('https://', '')
      subdomain.apiId = componentOutputs.id
    }

    if (componentOutputs.url.includes('cloudfront')) {
      // todo do we need to diff between cloudfront cdn and cloudfront website?
      subdomain.type = 'awsCloudFront'
      subdomain.url = componentOutputs.url.replace('https://', '')
      subdomain.distributionId = componentOutputs.id
    }

    subdomains.push(subdomain)
  }

  inputs.subdomains = subdomains

  return inputs
}

const getHostedZoneIdByDomain = async (clients, inputs) => {
  const hostedZonesRes = await clients.route53.listHostedZonesByName().promise()

  const hostedZone = hostedZonesRes.HostedZones.find(
    // Name has a period at the end, so we're using includes rather than equals
    (zone) => zone.Name.includes(inputs.domain)
  )

  if (!hostedZone) {
    throw Error(
      `Domain ${inputs.domain} was not found in your AWS account. Please purchase it from Route53 first then try again.`
    )
  }

  return hostedZone.Id.replace('/hostedzone/', '') // hosted zone id is always prefixed with this :(
}

const createCertificate = async (clients, inputs) => {
  const wildcardSubDomain = `*.${inputs.domain}`

  const params = {
    DomainName: inputs.domain,
    SubjectAlternativeNames: [inputs.domain, wildcardSubDomain],
    ValidationMethod: 'DNS'
  }

  const res = await clients.acm.requestCertificate(params).promise()

  return res.CertificateArn
}

const describeCertificateByArn = async (acm, certificateArn) => {
  const certificate = await acm.describeCertificate({ CertificateArn: certificateArn }).promise()
  return certificate && certificate.Certificate ? certificate.Certificate : null
}

const validateCertificate = async (clients, inputs, certificateArn) => {
  let readinessCheckCount = 16
  let statusCheckCount = 16
  let validationResourceRecord

  /**
   * Check Readiness
   * - Newly Created AWS ACM Certificates may not yet have the info needed to validate it
   * - Specifically, the "ResourceRecord" object in the Domain Validation Options
   * - Ensure this exists.
   */

  const checkReadiness = async function() {
    if (readinessCheckCount < 1) {
      throw new Error(
        'Your newly created AWS ACM Certificate is taking a while to initialize.  Please try running this component again in a few minutes.'
      )
    }

    const cert = await describeCertificateByArn(clients.acm, certificateArn)

    // Find root domain validation option resource record
    cert.DomainValidationOptions.forEach((option) => {
      if (inputs.domain === option.DomainName) {
        validationResourceRecord = option.ResourceRecord
      }
    })

    if (!validationResourceRecord) {
      readinessCheckCount--
      await utils.sleep(5000)
      return await checkReadiness()
    }
  }

  await checkReadiness()

  const checkRecordsParams = {
    HostedZoneId: inputs.hostedZoneId,
    MaxItems: '10',
    StartRecordName: validationResourceRecord.Name
  }

  // Check if the validation resource record sets already exist.
  // This might be the case if the user is trying to deploy multiple times while validation is occurring.
  const existingRecords = await clients.route53.listResourceRecordSets(checkRecordsParams).promise()

  if (!existingRecords.ResourceRecordSets.length) {
    // Create CNAME record for DNS validation check
    // NOTE: It can take 30 minutes or longer for DNS propagation so validation can complete, just continue on and don't wait for this...
    const recordParams = {
      HostedZoneId: inputs.hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: validationResourceRecord.Name,
              Type: validationResourceRecord.Type,
              TTL: 300,
              ResourceRecords: [
                {
                  Value: validationResourceRecord.Value
                }
              ]
            }
          }
        ]
      }
    }
    await clients.route53.changeResourceRecordSets(recordParams).promise()
  }

  /**
   * Check Validated Status
   * - Newly Validated AWS ACM Certificates may not yet show up as valid
   * - This gives them some time to update their status.
   */

  const checkStatus = async function() {
    if (statusCheckCount < 1) {
      throw new Error(
        'Your newly validated AWS ACM Certificate is taking a while to register as valid.  Please try running this component again in a few minutes.'
      )
    }

    const cert = await describeCertificateByArn(clients.acm, certificateArn)

    if (cert.Status !== 'ISSUED') {
      statusCheckCount--
      await utils.sleep(10000)
      return await checkStatus()
    }
  }

  await checkStatus()
}

const getCertificateArnByDomain = async (clients, inputs, context) => {
  const listRes = await clients.acm.listCertificates().promise()
  const certificateSummary = listRes.CertificateSummaryList.find(
    (cert) => cert.DomainName === inputs.domain
  )
  let certificateArn =
    certificateSummary && certificateSummary.CertificateArn
      ? certificateSummary.CertificateArn
      : null

  if (!certificateArn) {
    context.debug(`No existing AWS ACM Certificates found for the domain: ${inputs.domain}.`)
    context.debug(`Creating a new AWS ACM Certificate for the domain: ${inputs.domain}.`)
    certificateArn = await createCertificate(clients.acm, inputs.domain)
  }

  context.debug(`Checking the status of AWS ACM Certificate.`)
  const certificate = await describeCertificateByArn(clients.acm, certificateArn)

  if (certificate.Status === 'PENDING_VALIDATION') {
    context.debug(`AWS ACM Certificate Validation Status is "PENDING_VALIDATION".`)
    context.debug(`Validating AWS ACM Certificate via Route53 "DNS" method.`)
    await validateCertificate(clients, inputs, certificateArn)
    context.log(
      'Your AWS ACM Certificate has been created and is being validated via DNS.  This could take up to 30 minutes since it depends on DNS propagation.  Continuining deployment, but you may have to wait for DNS propagation.'
    )
  }

  return certificateArn
}

const mapDomainToApi = async (apig, domain, apiId) => {
  try {
    const params = {
      domainName: domain,
      restApiId: apiId,
      basePath: '(none)',
      stage: 'production'
    }
    // todo what if it already exists but for a different apiId
    return apig.createBasePathMapping(params).promise()
  } catch (e) {
    if (e.code === 'TooManyRequestsException') {
      await utils.sleep(2000)
      return mapDomainToApi(apig, domain, apiId)
    }
    throw e
  }
}

const createDomainInApig = async (clients, domain, hostedZoneId, certificateArn) => {
  try {
    const params = {
      domainName: domain,
      certificateArn: certificateArn,
      securityPolicy: 'TLS_1_2',
      endpointConfiguration: {
        types: ['EDGE']
      }
    }
    const res = await clients.apig.createDomainName(params).promise()
    const dnsRecord = {
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: domain,
              Type: 'A',
              AliasTarget: {
                HostedZoneId: res.distributionHostedZoneId,
                DNSName: res.distributionDomainName,
                EvaluateTargetHealth: false
              }
            }
          }
        ]
      }
    }

    return clients.route53.changeResourceRecordSets(dnsRecord).promise()
  } catch (e) {
    if (e.code === 'TooManyRequestsException') {
      await utils.sleep(2000)
      return createDomainInApig(clients.apig, domain, hostedZoneId, certificateArn)
    }
    throw e
  }
}

const addDomainToApig = async (clients, subdomain, hostedZoneId, certificateArn, context) => {
  try {
    context.debug(`Mapping domain ${subdomain.name} to API ID ${subdomain.apiId}`)
    await mapDomainToApi(clients.apig, subdomain.name, subdomain.apiId)
  } catch (e) {
    if (e.message === 'Invalid domain name identifier specified') {
      context.debug(`Domain ${subdomain.name} not found in API Gateway. Creating...`)

      const res = await createDomainInApig(clients, subdomain.name, hostedZoneId, certificateArn)

      context.debug(`Configuring DNS for API Gateway domain ${subdomain.name}.`)

      // retry domain deployment now that domain is created
      return addDomainToApig(clients, subdomain, hostedZoneId, certificateArn, context)
    }

    if (e.message === 'Base path already exists for this domain name') {
      context.debug(`Domain ${subdomain.name} is already mapped to API ID ${subdomain.apiId}.`)
      return
    }
    throw new Error(e)
  }
}
