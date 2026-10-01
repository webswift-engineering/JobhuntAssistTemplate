/** Employers not on the ATS auto-poll list — browse + hourly career-page watches. */
export interface CareerSite {
  name: string;
  url: string;
  /** Optional filtered search (backend / Canada/US). */
  searchUrl?: string;
}

export const MANUAL_CAREER_SITES: CareerSite[] = [
  {
    name: "Google",
    url: "https://careers.google.com/jobs",
    searchUrl:
      "https://careers.google.com/jobs/results?q=software+engineer&location=Canada",
  },
  {
    name: "Amazon",
    url: "https://www.amazon.jobs/",
    searchUrl:
      "https://www.amazon.jobs/en/search?base_query=software+engineer&country=CAN",
  },
  {
    name: "Apple",
    url: "https://jobs.apple.com/",
    searchUrl: "https://jobs.apple.com/en-us/search?search=backend+engineer",
  },
  {
    name: "Meta",
    url: "https://www.metacareers.com/jobs",
    searchUrl:
      "https://www.metacareers.com/jobs?q=backend%20engineer&country=CA",
  },
  {
    name: "Microsoft",
    url: "https://careers.microsoft.com/",
    searchUrl:
      "https://careers.microsoft.com/us/en/search-results?keywords=backend%20engineer",
  },
  {
    name: "NVIDIA",
    url: "https://jobs.nvidia.com/",
    searchUrl: "https://jobs.nvidia.com/careers?query=backend%20engineer",
  },
  {
    name: "Tesla",
    url: "https://www.tesla.com/careers",
    searchUrl: "https://www.tesla.com/careers/search?q=software%20engineer",
  },
  {
    name: "TikTok",
    url: "https://careers.tiktok.com/",
    searchUrl: "https://careers.tiktok.com/search?keyword=backend%20engineer",
  },
  {
    name: "Oracle",
    url: "https://www.oracle.com/careers/",
    searchUrl: "https://www.oracle.com/careers/search/?keyword=backend%20engineer",
  },
  {
    name: "IBM",
    url: "https://www.ibm.com/careers",
    searchUrl: "https://www.ibm.com/careers/search?q=backend%20engineer",
  },
  {
    name: "Cisco",
    url: "https://jobs.cisco.com/",
    searchUrl: "https://jobs.cisco.com/jobs/SearchJobs/?keyword=backend%20engineer",
  },
  {
    name: "Salesforce",
    url: "https://careers.salesforce.com/",
    searchUrl: "https://careers.salesforce.com/en/jobs/?search=backend%20engineer",
  },
  {
    name: "Adobe",
    url: "https://careers.adobe.com/",
    searchUrl: "https://careers.adobe.com/us/en/search-results?keywords=backend%20engineer",
  },
  {
    name: "Intel",
    url: "https://jobs.intel.com/",
    searchUrl: "https://jobs.intel.com/en/search-jobs?k=backend%20engineer",
  },
  {
    name: "AMD",
    url: "https://careers.amd.com/",
    searchUrl: "https://careers.amd.com/careers-home/jobs?keywords=backend%20engineer",
  },
  {
    name: "Qualcomm",
    url: "https://careers.qualcomm.com/",
    searchUrl: "https://careers.qualcomm.com/careers?query=software%20engineer",
  },
  {
    name: "Shopify",
    url: "https://www.shopify.com/careers",
    searchUrl: "https://www.shopify.com/careers/search?query=backend%20engineer",
  },
];
