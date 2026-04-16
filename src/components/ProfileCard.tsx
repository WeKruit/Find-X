"use client";

import type { PersonProfile, ScoredValue } from "@/types";

interface ProfileCardProps {
  profile: PersonProfile;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence >= 0.7
      ? "bg-green-100 text-green-800"
      : confidence >= 0.4
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";

  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${color}`}>
      {Math.round(confidence * 100)}%
    </span>
  );
}

function SourceTooltip({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <span className="text-xs text-gray-400 ml-1" title={sources.join("\n")}>
      ({sources.length} source{sources.length !== 1 ? "s" : ""})
    </span>
  );
}

export default function ProfileCard({ profile }: ProfileCardProps) {
  const primaryName = profile.names[0]?.value || "Unknown";
  const currentRole = profile.experiences?.find((e) => e.value.isCurrent) ?? profile.experiences?.[0];

  return (
    <div className="w-full max-w-2xl mx-auto bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 p-6 text-white">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold">{primaryName}</h2>
            {currentRole && (
              <p className="mt-1 text-blue-100">
                {[currentRole.value.title, currentRole.value.company].filter(Boolean).join(" at ")}
                <ConfidenceBadge confidence={currentRole.confidence} />
              </p>
            )}
            {profile.locations.length > 0 && (
              <p className="mt-1 text-blue-200 text-sm">
                {profile.locations[0].value.city}
              </p>
            )}
          </div>
          <div className="text-right">
            <ConfidenceBadge confidence={profile.confidence} />
            <p className="text-xs text-blue-200 mt-1">
              {profile.sources.length} source{profile.sources.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-6 space-y-6">
        {/* LLM Summary */}
        {profile.llmSummary && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Summary
            </h3>
            <p className="text-gray-800 text-sm leading-relaxed">
              {profile.llmSummary}
            </p>
          </div>
        )}

        {/* Raw bio snippet (shown only if no LLM summary) */}
        {!profile.llmSummary && profile.bioSnippet && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              About
            </h3>
            <p className="text-gray-700 text-sm italic">
              &ldquo;{profile.bioSnippet}&rdquo;
            </p>
          </div>
        )}

        {/* Experience */}
        {profile.experiences && profile.experiences.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Experience
            </h3>
            <ul className="space-y-3">
              {profile.experiences.map((exp, i) => (
                <li key={i} className="flex gap-3">
                  <div className="mt-1 flex-shrink-0 w-2 h-2 rounded-full bg-blue-400 mt-1.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">
                        {exp.value.title || exp.value.company}
                      </span>
                      {exp.value.title && exp.value.company && (
                        <span className="text-sm text-gray-500">at {exp.value.company}</span>
                      )}
                      {exp.value.isCurrent && (
                        <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">
                          Current
                        </span>
                      )}
                      <ConfidenceBadge confidence={exp.confidence} />
                      <SourceTooltip sources={exp.sources} />
                    </div>
                    {(exp.value.startDate || exp.value.endDate) && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {exp.value.startDate ?? "?"} — {exp.value.isCurrent ? "Present" : (exp.value.endDate ?? "?")}
                        {exp.value.location && ` · ${exp.value.location}`}
                      </p>
                    )}
                    {exp.value.description && (
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {exp.value.description}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Education */}
        {profile.education.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Education
            </h3>
            <ul className="space-y-1">
              {profile.education.map((edu, i) => (
                <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
                  <span>
                    {edu.value.institution}
                    {edu.value.degree && ` - ${edu.value.degree}`}
                    {edu.value.field && ` in ${edu.value.field}`}
                    {edu.value.year && ` (${edu.value.year})`}
                  </span>
                  <ConfidenceBadge confidence={edu.confidence} />
                  <SourceTooltip sources={edu.sources} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Skills */}
        {profile.skills.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Skills
            </h3>
            <div className="flex flex-wrap gap-2">
              {profile.skills.slice(0, 20).map((skill, i) => (
                <span
                  key={i}
                  className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full flex items-center gap-1"
                  title={`Confidence: ${Math.round(skill.confidence * 100)}% | Sources: ${skill.sources.join(", ")}`}
                >
                  {skill.value.name}{skill.value.proficiency ? ` (${skill.value.proficiency})` : ""}
                  <ConfidenceBadge confidence={skill.confidence} />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Social Profiles */}
        {profile.socialProfiles.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Social Profiles
            </h3>
            <ul className="space-y-1">
              {profile.socialProfiles.map((social, i) => (
                <li key={i} className="text-sm flex items-center gap-2">
                  <span className="font-medium text-gray-600 w-20">
                    {social.value.platform}
                  </span>
                  <a
                    href={social.value.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline truncate"
                  >
                    {social.value.url}
                  </a>
                  <ConfidenceBadge confidence={social.confidence} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Contact */}
        {(profile.emails.length > 0 || profile.phones.length > 0) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Contact
            </h3>
            <ul className="space-y-1">
              {profile.emails.map((email, i) => (
                <li key={`email-${i}`} className="text-sm text-gray-700 flex items-center gap-2">
                  <span className="font-medium text-gray-600 w-20">Email</span>
                  <span>{email.value}</span>
                  <ConfidenceBadge confidence={email.confidence} />
                  <SourceTooltip sources={email.sources} />
                </li>
              ))}
              {profile.phones.map((phone, i) => (
                <li key={`phone-${i}`} className="text-sm text-gray-700 flex items-center gap-2">
                  <span className="font-medium text-gray-600 w-20">Phone</span>
                  <span>{phone.value}</span>
                  <ConfidenceBadge confidence={phone.confidence} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Publications */}
        {profile.publications && profile.publications.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Publications
            </h3>
            <ul className="space-y-2">
              {profile.publications.map((pub, i) => (
                <li key={i} className="text-sm text-gray-700">
                  <span className="font-medium">{pub.value.title}</span>
                  {pub.value.venue && <span className="text-gray-500"> · {pub.value.venue}</span>}
                  {pub.value.year && <span className="text-gray-400"> ({pub.value.year})</span>}
                  {pub.value.url && (
                    <a href={pub.value.url} target="_blank" rel="noopener noreferrer"
                      className="ml-1 text-blue-500 hover:underline text-xs">↗</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Awards & Certifications */}
        {((profile.awards && profile.awards.length > 0) || (profile.certifications && profile.certifications.length > 0)) && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Awards & Certifications
            </h3>
            <ul className="space-y-1">
              {(profile.awards || []).map((award, i) => (
                <li key={`award-${i}`} className="text-sm text-gray-700 flex items-center gap-2">
                  <span>🏆 {award.value.title}{award.value.issuer && ` — ${award.value.issuer}`}{award.value.year && ` (${award.value.year})`}</span>
                  <ConfidenceBadge confidence={award.confidence} />
                </li>
              ))}
              {(profile.certifications || []).map((cert, i) => (
                <li key={`cert-${i}`} className="text-sm text-gray-700 flex items-center gap-2">
                  <span>📜 {cert.value.name}{cert.value.issuer && ` — ${cert.value.issuer}`}{cert.value.year && ` (${cert.value.year})`}</span>
                  <ConfidenceBadge confidence={cert.confidence} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Additional Facts */}
        {profile.additionalFacts && profile.additionalFacts.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Key Facts
            </h3>
            <ul className="space-y-1 list-disc list-inside">
              {profile.additionalFacts.slice(0, 10).map((fact, i) => (
                <li key={i} className="text-sm text-gray-700">{fact.value}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Names (if multiple) */}
        {profile.names.length > 1 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Also Known As
            </h3>
            <div className="flex flex-wrap gap-2">
              {profile.names.slice(1).map((name, i) => (
                <span key={i} className="text-sm text-gray-600">
                  {name.value}
                  <ConfidenceBadge confidence={name.confidence} />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Sources */}
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Sources ({profile.sources.length})
          </h3>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {profile.sources
              .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
              .map((source, i) => (
                <li key={i} className="text-xs text-gray-500 flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      source.reliability >= 0.7
                        ? "bg-green-400"
                        : source.reliability >= 0.4
                          ? "bg-yellow-400"
                          : "bg-gray-400"
                    }`}
                  />
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline truncate"
                  >
                    {source.url}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
